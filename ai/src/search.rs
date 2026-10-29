use crate::board::{Board, Move, REFLECT};
use crate::forcing::{CounterplayRecord, ForcingSearch, ForcingStats};
use crate::optics::{
    additions, along, connection_distances, connections, defenses, settle_next, source_distance,
    trace, Trace, INF,
};
use crate::planning::{self, Plan};
use crate::{clock_now as now_ms, Action, SearchCandidate, SearchIteration, Stats};
use std::collections::{HashMap, HashSet};

const WIN: i32 = 1_000_000;
const LIMIT: i32 = 2_000_000;
// Prefer a diagonal only when the evaluated alternatives are within 20 points.
// Mirror shape must never outrank a materially better defense.
const DIAGONAL_PREFERENCE: i32 = 20;

fn selection_score(action: Move, score: i32) -> i32 {
    score
        + if matches!(action, Move::Diag(..)) && score.abs() < WIN / 2 {
            DIAGONAL_PREFERENCE
        } else {
            0
        }
}

// Initiative is a decision priority, not a few extra leaf-evaluation points.
// A reply that blocks a check does not undo the tempo it spent defending.
// Tactical wins/losses found by the search still take precedence.
fn selection_priority(score: i32, direct_attack: bool) -> u8 {
    if score >= WIN / 2 {
        5
    } else if score <= -WIN / 2 {
        1
    } else {
        2 + 2 * u8::from(direct_attack)
    }
}

#[derive(Clone, Copy)]
struct Ranked {
    action: Move,
    score: i32,
    own_signature: u64,
    attack: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Request;

    fn rotate(board: &Board) -> Board {
        let n = board.size;
        let mut turned = board.clone();
        turned.horizontal.fill(0);
        turned.vertical.fill(0);
        turned.diagonals.fill(0);
        turned.home_at.fill(0);
        for (color, home) in turned.homes.iter_mut().enumerate() {
            if let Some(h) = home {
                (h.x, h.y, h.dir) = (n - 1 - h.y, h.x, (h.dir + 1) % 4);
                turned.home_at[h.y * n + h.x] = color as u8 + 1;
            }
        }
        for (i, &value) in board.horizontal.iter().enumerate() {
            turned.vertical[(i % n) * (n + 1) + n - i / n] = value;
        }
        for (i, &value) in board.vertical.iter().enumerate() {
            turned.horizontal[(i % (n + 1)) * n + n - 1 - i / (n + 1)] = value;
        }
        for (i, &value) in board.diagonals.iter().enumerate() {
            if value != 0 {
                turned.diagonals[(i % n) * n + n - 1 - i / n] =
                    1 + (value - 1) / 2 * 2 + (1 - (value - 1) % 2);
            }
        }
        turned.refresh_hash();
        turned
    }

    #[test]
    fn passive_block_survives_narrow_defense_search_in_every_rotation() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/test-first-move.json")).unwrap();
        let mut board = serde_json::from_value::<Request>(fixture["request"].clone())
            .unwrap()
            .into_board()
            .unwrap();
        board.put(Move::Diag(2 * 16 + 13, 0), 1);
        settle_next(&mut board);
        let mut block = Move::Vertical(2 * 17 + 13);
        for _ in 0..4 {
            let before = board.position_key();
            let mut search = Search::new(1, 30_000.0, 1_000_000);
            let choices = search.moves(&mut board, 4, false).unwrap();
            assert!(choices.threatened);
            assert!(
                choices.choices.iter().any(|r| r.action == block),
                "a passive cut at the attack junction must not be lost to diagonal development"
            );
            for candidate in &choices.choices {
                board.put(candidate.action, board.current);
                assert!(!board.encloses(board.current));
                assert_eq!(trace(&board, 1, false).hits & 1, 0);
                board.remove(candidate.action);
            }
            assert_eq!(before, board.position_key());
            let n = board.size;
            block = match block {
                Move::Horizontal(i) => Move::Vertical((i % n) * (n + 1) + n - i / n),
                Move::Vertical(i) => Move::Horizontal((i % (n + 1)) * n + n - 1 - i / (n + 1)),
                _ => unreachable!(),
            };
            board = rotate(&board);
        }
    }

    #[test]
    fn quiet_turn_prefers_a_direct_attack_in_every_rotation() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/attack-initiative.json")).unwrap();
        let mut board = serde_json::from_value::<Request>(fixture["request"].clone())
            .unwrap()
            .into_board()
            .unwrap();
        for _ in 0..4 {
            assert_eq!(trace(&board, 0, false).hits & 2, 0);
            let before = board.position_key();
            let mut search = Search::new(1, 30_000.0, 1_000_000);
            let action = search.choose(&mut board, 1).unwrap();
            assert_eq!(board.position_key(), before);
            board.put(action, 1);
            assert_eq!(trace(&board, 0, false).hits & 2, 0);
            assert_ne!(trace(&board, 1, false).hits & 1, 0);
            board.remove(action);
            board = rotate(&board);
        }
    }

    #[test]
    fn search_tactics_override_initiative_but_static_scores_do_not() {
        assert!(selection_priority(-650, true) > selection_priority(625, false));
        assert!(selection_priority(0, false) > selection_priority(-WIN + 4, true));
        assert!(selection_priority(WIN - 4, false) > selection_priority(625, true));
        assert!(selection_score(Move::Diag(0, 0), 600) > selection_score(Move::Horizontal(0), 610));
        assert!(selection_score(Move::Diag(0, 0), -300) < selection_score(Move::Horizontal(0), -200));
    }

    #[test]
    fn opponent_forcing_checks_precede_defense_width_pruning() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/counter-forcing.json")).unwrap();
        let mut board = serde_json::from_value::<Request>(fixture["request"].clone())
            .unwrap().into_board().unwrap();
        let before = board.clone();
        let bad = Move::Diag(12 * 16 + 13, 1);
        let mut search = Search::new(0, 30_000.0, 1_000_000);
        let choices = search.moves(&mut board, 1, true).unwrap();
        assert!(choices.threatened);
        assert_eq!(search.refuted.get(&bad), Some(&3));
        assert_eq!(search.counterplay.len(), 16, "check every legal save before pruning");
        assert_eq!(choices.choices.len(), 1);
        assert!(!search.refuted.contains_key(&choices.choices[0].action));
        assert_eq!(before.position_key(), board.position_key());
        assert_eq!(before.horizontal, board.horizontal);
        assert_eq!(before.vertical, board.vertical);
        assert_eq!(before.diagonals, board.diagonals);
        assert_eq!((before.current, before.alive), (board.current, board.alive));
        // A real proof beats even an optimistic strategic score, and does not
        // get reinstated by the ordinary attack or diagonal preferences.
        search.prioritize_attack = true;
        search.root_attacks.insert(bad);
        assert!(search.priority(bad, WIN) < search.priority(choices.choices[0].action, -WIN));
    }

    #[test]
    fn interrupted_counterplay_is_unknown_and_restores_every_placement() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/counter-forcing.json")).unwrap();
        let mut board = serde_json::from_value::<Request>(fixture["request"].clone())
            .unwrap().into_board().unwrap();
        let before = board.clone();
        for limit in [0, 3, 12] {
            let mut search = Search::new(0, 30_000.0, limit);
            let mut choices = [Move::Diag(12 * 16 + 13, 1), Move::Diag(12 * 16 + 11, 0)]
                .map(|action| Ranked { action, score: 123, own_signature: 0, attack: false });
            search.check_counterplay(&mut board, &mut choices);
            assert!(search.refuted.is_empty());
            assert!(choices.iter().all(|r| r.score == 123));
            assert!(search.counterplay.iter().all(|r| r.stats.status == "budget" && r.stats.proof.is_none()));
            assert!(search.nodes <= limit);
            assert_eq!(before.position_key(), board.position_key());
            assert_eq!(before.horizontal, board.horizontal);
            assert_eq!(before.vertical, board.vertical);
            assert_eq!(before.diagonals, board.diagonals);
            assert_eq!((before.current, before.alive), (board.current, board.alive));
        }
    }

    #[test]
    fn root_defenses_keep_both_blocking_rays() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/defense-diversity.json")).unwrap();
        let mut board = serde_json::from_value::<Request>(fixture["request"].clone())
            .unwrap()
            .into_board()
            .unwrap();
        let mut search = Search::new(1, 30_000.0, 1_000_000);
        let choices = search.moves(&mut board, 12, true).unwrap();
        assert!(choices.threatened);
        assert!(!search.prioritize_attack);
        assert!(choices
            .choices
            .iter()
            .any(|r| matches!(r.action, Move::Diag(c, _) if c % 16 == 2)));
        assert!(choices
            .choices
            .iter()
            .any(|r| matches!(r.action, Move::Diag(c, _) if c / 16 == 13)));
    }

    #[test]
    fn root_keeps_both_safe_orientations_at_each_selected_location() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/attack-initiative.json")).unwrap();
        let mut board = serde_json::from_value::<Request>(fixture["request"].clone())
            .unwrap().into_board().unwrap();
        for _ in 0..4 {
            let mut search = Search::new(1, 30_000.0, 1_000_000);
            let candidates = search.moves(&mut board, 12, true).unwrap();
            let mut pairs = 0;
            for r in &candidates.choices {
                if let Move::Diag(cell, ori) = r.action {
                    let other = Move::Diag(cell, 1 - ori);
                    board.put(other, board.current);
                    let safe = !board.encloses(board.current) && trace(&board, 0, false).hits & 2 == 0;
                    board.remove(other);
                    if safe {
                        assert!(candidates.choices.iter().any(|r| r.action == other));
                        pairs += 1;
                    }
                }
            }
            assert!(pairs >= 2);
            assert!(candidates.choices.len() <= 24);
            board = rotate(&board);
        }
    }
}
#[derive(Clone, Copy)]
struct Entry {
    depth: i32,
    extension: u8,
    score: i32,
    bound: i8,
    best: Option<Move>,
}
#[derive(Debug)]
struct Interrupted;
#[derive(Clone)]
struct Moves {
    choices: Vec<Ranked>,
    threatened: bool,
    complete: bool,
}

pub struct Search {
    root: u8,
    start: f64,
    deadline: f64,
    max_nodes: u64,
    pub nodes: u64,
    table: HashMap<u64, Entry>,
    evaluations: HashMap<u64, i32>,
    potentials: HashMap<(u64, u8, u8), (i32, i32, i32)>,
    defense_cache: HashMap<(u64, usize), Moves>,
    fallback: Option<Ranked>,
    fallback_safe: bool,
    completed_depth: u8,
    selection_depth: u8,
    completed_score: i32,
    defense_complete: bool,
    root_plans: HashMap<Move, Plan>,
    wins: HashMap<u64, Option<Move>>,
    anticipated: HashSet<Move>,
    enemy_connections: HashSet<usize>,
    reduced_connections: HashSet<Move>,
    root_attacks: HashSet<Move>,
    prioritize_attack: bool,
    candidates: usize,
    stop_reason: &'static str,
    reason: String,
    preferred_diagonal: bool,
    pub minimum_depth: u8,
    iterations: Vec<SearchIteration>,
    partial_iteration: Option<SearchIteration>,
    forcing: Option<ForcingStats>,
    counterplay: Vec<CounterplayRecord>,
    refuted: HashMap<Move, u8>,
}

impl Search {
    pub fn new(root: u8, budget_ms: f64, max_nodes: u64) -> Self {
        let start = now_ms();
        Self {
            root,
            start,
            deadline: start + budget_ms,
            max_nodes,
            nodes: 0,
            table: HashMap::new(),
            evaluations: HashMap::new(),
            potentials: HashMap::new(),
            defense_cache: HashMap::new(),
            fallback: None,
            fallback_safe: false,
            completed_depth: 0,
            selection_depth: 0,
            completed_score: 0,
            defense_complete: false,
            root_plans: HashMap::new(),
            wins: HashMap::new(),
            anticipated: HashSet::new(),
            enemy_connections: HashSet::new(),
            reduced_connections: HashSet::new(),
            root_attacks: HashSet::new(),
            prioritize_attack: false,
            candidates: 0,
            stop_reason: "time-limit",
            reason: String::new(),
            preferred_diagonal: false,
            minimum_depth: 0,
            iterations: Vec::new(),
            partial_iteration: None,
            forcing: None,
            counterplay: Vec::new(),
            refuted: HashMap::new(),
        }
    }
    fn check(&self) -> Result<(), Interrupted> {
        if self.nodes >= self.max_nodes || now_ms() >= self.deadline {
            Err(Interrupted)
        } else {
            Ok(())
        }
    }
    fn terminal(&self, board: &Board, ply: usize) -> Option<i32> {
        if !board.active(self.root) {
            Some(-WIN + ply as i32)
        } else if board.alive.count_ones() == 1 {
            Some(WIN - ply as i32)
        } else {
            None
        }
    }
    fn beams(board: &Board, paths: bool) -> Vec<(u8, Trace)> {
        board
            .players
            .iter()
            .filter(|&&c| board.active(c))
            .map(|&c| (c, trace(board, c, paths)))
            .collect()
    }
    fn witness<'a>(board: &Board, beams: &'a [(u8, Trace)]) -> Option<&'a Trace> {
        let mut c = board.next_alive(board.current);
        while c != board.current {
            if let Some((_, beam)) = beams
                .iter()
                .find(|(p, t)| *p == c && t.hits & (1 << board.current) != 0)
            {
                return Some(beam);
            }
            c = board.next_alive(c);
        }
        None
    }
    fn threat_cells(board: &Board, color: u8, beam: &Trace, distance: &[u16]) -> HashSet<usize> {
        let mut cells = HashSet::new();
        for (cell, &dirs) in beam.seen.iter().enumerate() {
            for d in 0..4 {
                if dirs & (1 << d) != 0 {
                    additions(board, color, cell * 4 + d, |t, m| {
                        if distance[t.to] == 0 {
                            cells.insert(planning::cell_of(board, m));
                        }
                    });
                }
            }
        }
        cells
    }
    fn winning_move(&mut self, board: &mut Board, color: u8) -> Result<Option<Move>, Interrupted> {
        if board.alive.count_ones() != 2 {
            return Ok(None);
        }
        let key = board.position_key() ^ crate::board::mix((color as u64) << 40);
        if let Some(&cached) = self.wins.get(&key) {
            return Ok(cached);
        }
        self.check()?;
        let enemy = board.next_alive(color);
        let beam = trace(board, color, false);
        let distance = connection_distances(board, color, 1 << enemy);
        let mut actions = HashSet::new();
        for (cell, &dirs) in beam.seen.iter().enumerate() {
            for d in 0..4 {
                if dirs & (1 << d) != 0 {
                    additions(board, color, cell * 4 + d, |t, m| {
                        if distance[t.to] == 0 {
                            actions.insert(m);
                        }
                    });
                }
            }
        }
        let mut actions: Vec<_> = actions.into_iter().collect();
        actions.sort_unstable();
        let mut winner = None;
        for action in actions {
            self.check()?;
            board.put(action, color);
            let legal =
                !board.encloses(color) && trace(board, enemy, false).hits & (1 << color) == 0;
            let wins = if legal {
                let r = planning::resistance(board, color, enemy, 1, || self.check().is_ok());
                r.complete && r.saves == 0
            } else {
                false
            };
            board.remove(action);
            self.check()?;
            if wins {
                winner = Some(action);
                break;
            }
        }
        if self.wins.len() < 16_384 {
            self.wins.insert(key, winner);
        }
        Ok(winner)
    }
    fn raw_moves(
        &mut self,
        board: &mut Board,
        beams: &[(u8, Trace)],
        threatened: bool,
        root: bool,
    ) -> Vec<Ranked> {
        let me = board.current;
        let our = &beams.iter().find(|(c, _)| *c == me).unwrap().1;
        let route_map = if root && !threatened {
            Some(connections(board, me, board.alive & !(1 << me)))
        } else {
            None
        };
        let distance = route_map
            .as_ref()
            .map(|m| m.distance.clone())
            .unwrap_or_else(|| connection_distances(board, me, board.alive & !(1 << me)));
        let mut urgent = HashSet::new();
        if !threatened {
            for (enemy, beam) in beams.iter().filter(|(c, _)| *c != me) {
                let enemy_map = connection_distances(board, *enemy, 1 << me);
                urgent.extend(Self::threat_cells(board, *enemy, beam, &enemy_map));
            }
            if root {
                self.enemy_connections = urgent.clone();
            }
            if root && board.alive.count_ones() == 2 {
                let enemy = board.next_alive(me);
                if let Ok(Some(action)) = self.winning_move(board, enemy) {
                    board.put(action, enemy);
                    let future = trace(board, enemy, true);
                    self.anticipated.extend(defenses(board, &future, me));
                    // Also occupy the opponent's winning placement itself.
                    board.remove(action);
                    self.anticipated.insert(action);
                    if let Move::Diag(cell, ori) = action {
                        self.anticipated.insert(Move::Diag(cell, 1 - ori));
                    }
                }
            }
        }
        let candidates: Vec<_> = if threatened {
            defenses(board, Self::witness(board, beams).unwrap(), me)
        } else {
            board
                .all_moves()
                .filter(|&m| {
                    let cell = planning::cell_of(board, m);
                    // Edges touch two cells; test both sides to retain useful returns.
                    let touches = |c: usize| beams.iter().any(|(_, t)| t.seen[c] != 0);
                    self.anticipated.contains(&m)
                        || touches(cell)
                        || match m {
                            Move::Horizontal(_) => cell >= board.size && touches(cell - board.size),
                            Move::Vertical(i) => i % (board.size + 1) > 0 && touches(cell - 1),
                            _ => false,
                        }
                })
                .collect()
        };
        let mut ranked = Vec::new();
        for action in candidates {
            let cell = planning::cell_of(board, action);
            let enemy_count = beams
                .iter()
                .filter(|(c, t)| *c != me && t.seen[cell] != 0)
                .count() as i32;
            let mut remaining = INF;
            match action {
                Move::Diag(c, ori) => {
                    for (d, &r) in REFLECT[ori as usize].iter().enumerate() {
                        if our.seen[c] & (1 << d) != 0 {
                            along(board, me, c, r, |t| {
                                remaining = remaining.min(distance[t.to])
                            });
                        }
                    }
                }
                _ => {
                    for c in [
                        cell,
                        cell.saturating_sub(board.size),
                        cell.saturating_sub(1),
                    ] {
                        for d in 0..4 {
                            if our.seen[c] & (1 << d) != 0 {
                                additions(board, me, c * 4 + d, |t, m| {
                                    if m == action {
                                        remaining = remaining.min(distance[t.to]);
                                    }
                                });
                            }
                        }
                    }
                }
            }
            let connect = if remaining == INF {
                -2000
            } else {
                10_000 - 1800 * i32::from(remaining.min(8))
            };
            ranked.push(Ranked {
                action,
                own_signature: 0,
                attack: remaining == 0,
                score: connect
                    + enemy_count * 60
                    + if matches!(action, Move::Diag(..)) {
                        180
                    } else {
                        0
                    }
                    + if urgent.contains(&cell) { 2200 } else { 0 },
            });
            if root && self.anticipated.contains(&action) {
                ranked.last_mut().unwrap().score += 40_000;
            }
        }
        if root && !threatened {
            let proposals = planning::proposals(board, me, our, beams, route_map.as_ref().unwrap());
            let mut per_region = [0usize; 9];
            let mut verified = 0;
            // Reserve most of the budget for real opponent replies. A failed
            // route is simply discarded; it is never treated as a proven cost.
            let plan_deadline = self.start + (self.deadline - self.start) * 0.25;
            for plan in proposals {
                if verified >= 36 || now_ms() >= plan_deadline {
                    break;
                }
                let action = plan.actions[0];
                let group = planning::region(board, me, action);
                if per_region[group] >= 8 {
                    continue;
                }
                if planning::verify(board, me, &plan) {
                    per_region[group] += 1;
                    verified += 1;
                    if let Some(r) = ranked.iter_mut().find(|r| r.action == action) {
                        r.score += plan.score();
                    }
                    self.root_plans.insert(action, plan);
                }
            }
        }
        ranked.sort_by(|a, b| {
            b.attack
                .cmp(&a.attack)
                .then_with(|| b.score.cmp(&a.score))
                .then_with(|| a.action.cmp(&b.action))
        });
        ranked
    }
    /// All accepted moves pass actual enclosure and next-player laser checks.
    fn rank_legal(
        &mut self,
        board: &mut Board,
        action: Move,
        root: bool,
        before: &[(u8, Trace)],
    ) -> Option<Ranked> {
        let me = board.current;
        board.put(action, me);
        if board.encloses(me) {
            board.remove(action);
            return None;
        }
        let beams = Self::beams(board, false);
        let immediate = board.next_alive(me);
        let unsafe_now = beams
            .iter()
            .any(|(c, t)| *c == immediate && t.hits & (1 << me) != 0);
        let threats = beams
            .iter()
            .filter(|(c, t)| *c != me && t.hits & (1 << me) != 0)
            .count() as i32;
        let ours = &beams.iter().find(|(c, _)| *c == me).unwrap().1;
        let attacks = (ours.hits & board.alive & !(1 << me)).count_ones() as i32;
        let own_signature = ours.seen.iter().enumerate().fold(0u64, |hash, (i, &dirs)| {
            hash ^ crate::board::mix(((i as u64) << 4) | dirs as u64)
        });
        let interference: i64 = beams
            .iter()
            .filter(|(c, _)| *c != me)
            .map(|(c, t)| {
                before.iter().find(|(p, _)| p == c).unwrap().1.count as i64 - t.count as i64
            })
            .sum();
        let mut score = attacks * 2200 - threats * 6000
            + (interference * 400 / (board.size as i64 * 4).max(1)).clamp(-600, 600) as i32
            + if matches!(action, Move::Diag(..)) {
                180
            } else {
                0
            };
        if root && !unsafe_now {
            for (enemy, beam) in beams.iter().filter(|(c, _)| *c != me) {
                let map = connection_distances(board, *enemy, 1 << me);
                let cost = source_distance(board, *enemy, &map).min(8);
                let opportunities = Self::threat_cells(board, *enemy, beam, &map).len();
                if board.alive.count_ones() == 2 && opportunities < self.enemy_connections.len() {
                    self.reduced_connections.insert(action);
                }
                score += i32::from(cost) * 240 - opportunities.min(8) as i32 * 90;
            }
        }
        if !unsafe_now && attacks > 0 && board.alive.count_ones() == 2 {
            let resistance =
                planning::resistance(board, me, immediate, if root { 4 } else { 1 }, || {
                    self.check().is_ok()
                });
            if resistance.complete && resistance.saves == 0 {
                score = WIN;
            } else if resistance.saves > 0 {
                score += 1600 / resistance.saves as i32;
            }
        }
        board.remove(action);
        let ranked = Ranked {
            action,
            score,
            own_signature,
            attack: attacks > 0,
        };
        if root {
            let better = self.fallback.is_none_or(|old| {
                (
                    !unsafe_now,
                    selection_priority(
                        ranked.score,
                        self.prioritize_attack && ranked.attack,
                    ),
                    selection_score(ranked.action, ranked.score),
                ) > (
                    self.fallback_safe,
                    selection_priority(
                        old.score,
                        self.prioritize_attack && old.attack,
                    ),
                    selection_score(old.action, old.score),
                )
            });
            if better {
                self.fallback = Some(ranked);
                self.fallback_safe = !unsafe_now;
            }
        }
        if unsafe_now {
            None
        } else {
            Some(ranked)
        }
    }
    fn moves(&mut self, board: &mut Board, width: usize, root: bool) -> Result<Moves, Interrupted> {
        let cache_key = (board.position_key(), width);
        if !root {
            if let Some(cached) = self.defense_cache.get(&cache_key) {
                return Ok(cached.clone());
            }
        }
        let beams = Self::beams(board, true);
        let threatened = Self::witness(board, &beams).is_some();
        if root {
            self.prioritize_attack = !threatened && board.alive.count_ones() == 2;
        }
        if threatened {
            let result = self.defensive_moves(board, width, root, &beams)?;
            if !root && self.defense_cache.len() < 8192 {
                self.defense_cache.insert(cache_key, result.clone());
            }
            return Ok(result);
        }
        let raw = self.raw_moves(board, &beams, threatened, root);
        let width = if root && !self.anticipated.is_empty() {
            width.max(32)
        } else {
            width
        };
        // Every possible immediate attack is checked for an unanswerable shot
        // before strategic width pruning. Otherwise a single winning mirror can
        // disappear behind many superficially similar, easily blocked attacks.
        let mut checked = HashMap::new();
        for candidate in raw.iter().filter(|r| r.attack) {
            if !root || self.fallback.is_some() {
                self.check()?;
            }
            let r = self.rank_legal(board, candidate.action, root, &beams);
            if let Some(winner) = r.filter(|r| r.score >= WIN) {
                return Ok(Moves {
                    choices: vec![winner],
                    threatened,
                    complete: false,
                });
            }
            checked.insert(candidate.action, r);
        }
        let raw_len = raw.len();
        let priorities: HashMap<_, _> = raw.iter().map(|r| (r.action, r.score)).collect();
        let mut visited = HashSet::new();
        let mut ranked = Vec::new();
        let mut complete = true;
        let mut per_cell = HashMap::new();
        let mut root_locations = HashSet::new();
        let mut regions = [0usize; 9];
        'candidates: for candidate in raw {
            let mut pair = vec![candidate.action];
            if let Move::Diag(cell, ori) = candidate.action {
                let other = Move::Diag(cell, 1 - ori);
                if priorities.contains_key(&other) {
                    pair.push(other);
                }
            }
            for action in pair {
                if !visited.insert(action) {
                    continue;
                }
                if visited.len() > 1 && (!root || self.fallback.is_some()) {
                    self.check()?;
                }
                if let Some(mut r) = checked
                    .remove(&action)
                    .unwrap_or_else(|| self.rank_legal(board, action, root, &beams))
                {
                    if r.score >= WIN {
                        ranked.clear();
                        ranked.push(r);
                        complete = false;
                        break 'candidates;
                    }
                    r.score += priorities[&action];
                    let cell = planning::cell_of(board, action);
                    let signature = (cell, r.own_signature);
                    if !root && !threatened && matches!(action, Move::Diag(..)) {
                        if let Some(&i) = per_cell.get(&signature) {
                            let old: &mut Ranked = &mut ranked[i];
                            if r.score > old.score {
                                *old = r;
                            }
                            continue;
                        }
                    }
                    let group = planning::region(board, board.current, action);
                    let location = match action {
                        Move::Diag(cell, _) => Move::Diag(cell, 0),
                        other => other,
                    };
                    // At the root, budget locations rather than orientations.
                    // Equal own beams say nothing about the opponent's future
                    // reflections. Search both orientations without crowding
                    // out the other spatial routes from the shortlist.
                    let paired = root && root_locations.contains(&location);
                    if !threatened
                        && !paired
                        && regions[group] >= width.div_ceil(3).max(2)
                        && ranked.len() >= width / 2
                    {
                        continue;
                    }
                    if !root && !threatened && matches!(action, Move::Diag(..)) {
                        per_cell.insert(signature, ranked.len());
                    }
                    if !paired {
                        regions[group] += 1;
                    }
                    if root {
                        root_locations.insert(location);
                    }
                    ranked.push(r);
                }
            }
            if (if root { root_locations.len() } else { ranked.len() }) >= width {
                complete = visited.len() == raw_len;
                break;
            }
        }
        if ranked.is_empty()
            && (!threatened || board.alive.count_ones() > 2 || (root && self.fallback.is_none()))
        {
            let all: Vec<_> = board.all_moves().collect();
            for action in all {
                if !root || self.fallback.is_some() {
                    self.check()?;
                }
                if let Some(r) = self.rank_legal(board, action, root, &beams) {
                    ranked.push(r);
                }
                if ranked.len() >= width {
                    complete = false;
                    break;
                }
            }
        }
        ranked.sort_by(|a, b| {
            (root && self.prioritize_attack && b.attack)
                .cmp(&(root && self.prioritize_attack && a.attack))
                .then_with(|| b.score.cmp(&a.score))
                .then_with(|| a.action.cmp(&b.action))
        });
        if root && threatened {
            self.defense_complete = complete;
        }
        Ok(Moves {
            choices: ranked,
            threatened,
            complete,
        })
    }

    /// A save must intersect a real hit path. Validate this whole small set
    /// before strategic pruning: a passive edge can be much stronger than a
    /// diagonal which develops our beam but leaves the attacker one turn away.
    fn defensive_moves(
        &mut self,
        board: &mut Board,
        width: usize,
        root: bool,
        beams: &[(u8, Trace)],
    ) -> Result<Moves, Interrupted> {
        let me = board.current;
        let actions = defenses(board, Self::witness(board, beams).unwrap(), me);
        let mut ranked = Vec::new();
        for action in actions {
            if !root || self.fallback.is_some() {
                self.check()?;
            }
            let Some(candidate) = self.rank_legal(board, action, root, beams) else {
                continue;
            };
            if candidate.score >= WIN {
                return Ok(Moves {
                    choices: vec![candidate],
                    threatened: true,
                    complete: false,
                });
            }
            ranked.push(candidate);
        }
        let legal_count = ranked.len();
        ranked.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.action.cmp(&b.action)));
        // At the root, compare connection maps for every legal save BEFORE
        // pruning. A long column of similar blocks must not hide another ray.
        // Internal nodes retain the cheaper family shortlist to bound work.
        let mut families = [0usize; 3];
        let mut counterattacks = 0;
        ranked.retain(|candidate| {
            if root {
                return true;
            }
            let family = match candidate.action {
                Move::Diag(..) => 0,
                Move::Horizontal(..) => 1,
                Move::Vertical(..) => 2,
            };
            let keep = families[family] < width || (candidate.attack && counterattacks < width);
            if keep {
                families[family] += 1;
                if candidate.attack {
                    counterattacks += 1;
                }
            }
            keep
        });
        for candidate in &mut ranked {
            self.check()?;
            let action = candidate.action;
            board.put(action, me);
            let (own_cost, own_options, own_reach) =
                self.potential(board, me, board.alive & !(1 << me));
            let mut enemy_cost = 12;
            let mut enemy_options = 0;
            let mut enemy_reach = 0;
            for &enemy in &board.players {
                if enemy == me || !board.active(enemy) {
                    continue;
                }
                // These maps describe the board AFTER the block. In particular,
                // denying the attacker's next connection matters even when the
                // block contributes no new branch to our own beam.
                let (cost, options, reach) = self.potential(board, enemy, 1 << me);
                enemy_cost = enemy_cost.min(cost);
                enemy_options = enemy_options.max(options);
                enemy_reach = enemy_reach.max(reach);
            }
            board.remove(action);
            candidate.score =
                (enemy_cost - own_cost) * 1200 + (own_options - enemy_options) * 25 + own_reach
                    - enemy_reach
                    + if candidate.attack { 2200 } else { 0 }
                    + if matches!(action, Move::Diag(..)) {
                        DIAGONAL_PREFERENCE
                    } else {
                        0
                    };
        }
        if root {
            // Check ALL legal saves before the strategic shortlist can hide
            // the one that escapes a forcing sequence.
            self.check_counterplay(board, &mut ranked);
        }
        ranked.sort_by(|a, b| {
            self.refuted.contains_key(&a.action).cmp(&self.refuted.contains_key(&b.action))
                .then_with(|| b.score.cmp(&a.score))
                .then_with(|| a.action.cmp(&b.action))
        });
        let complete = legal_count <= width;
        if root && ranked.len() > width {
            // Reserve representatives of different blocking regions/families,
            // then fill the rest by score. This is diversity, not equivalence:
            // nearby blocks can have different future replies.
            let mut groups = HashSet::new();
            let mut keep = HashSet::new();
            for (i, candidate) in ranked.iter().enumerate() {
                let family = match candidate.action {
                    Move::Diag(..) => 0,
                    Move::Horizontal(..) => 1,
                    Move::Vertical(..) => 2,
                };
                if groups.insert((family, planning::region(board, me, candidate.action))) {
                    keep.insert(i);
                    if keep.len() >= width.div_ceil(2) {
                        break;
                    }
                }
            }
            for i in 0..ranked.len() {
                if keep.len() >= width {
                    break;
                }
                keep.insert(i);
            }
            ranked = ranked
                .into_iter()
                .enumerate()
                .filter_map(|(i, candidate)| keep.contains(&i).then_some(candidate))
                .collect();
        } else {
            ranked.truncate(width);
        }
        if root {
            self.defense_complete = complete;
        }
        Ok(Moves {
            choices: ranked,
            threatened: true,
            complete,
        })
    }
    fn check_counterplay(&mut self, board: &mut Board, candidates: &mut [Ranked]) {
        if board.alive.count_ones() != 2 || candidates.len() <= 1 {
            return;
        }
        let old_current = board.current;
        let old_alive = board.alive;
        // Share a bounded tactical allowance fairly. A costly first candidate
        // cannot consume the allowance for every other candidate. Unused time
        // and nodes flow to the remaining checks, not outside the turn budget.
        let deadline = now_ms() + ((self.deadline - now_ms()).max(0.0) * 0.3).min(4000.0);
        let mut nodes_left = (self.max_nodes.saturating_sub(self.nodes) / 3).min(40_000);
        let count = candidates.len();
        for (index, candidate) in candidates.iter_mut().enumerate() {
            let remaining = count - index;
            board.put(candidate.action, old_current);
            settle_next(board);
            let mut solver = ForcingSearch::new(
                board,
                (deadline - now_ms()).max(0.0) / remaining as f64,
                nodes_left / remaining as u64,
                Vec::new(),
            );
            // This is an attack-count bound independent of strategic ply
            // depth. A shallow alpha-beta horizon must not disable this check.
            let (proof, stats) = solver.run(board, 4);
            board.current = old_current;
            board.alive = old_alive;
            board.remove(candidate.action);
            self.nodes += stats.nodes;
            nodes_left = nodes_left.saturating_sub(stats.nodes);
            if let Some(proof) = proof {
                self.refuted.insert(candidate.action, proof.turns);
                candidate.score = -WIN + 2 * i32::from(proof.turns);
            }
            self.counterplay.push(CounterplayRecord {
                action: Action::from_move(candidate.action, board.size),
                stats,
            });
        }
    }

    fn potential(&mut self, board: &Board, color: u8, targets: u8) -> (i32, i32, i32) {
        // Optical connectivity is independent of whose turn it is. Reuse the
        // maps summarized while ranking a block when its resulting position
        // is subsequently evaluated in the game tree.
        let key = (board.hash, color, targets);
        if let Some(&cached) = self.potentials.get(&key) {
            return cached;
        }
        let beam = trace(board, color, false);
        let distance = connection_distances(board, color, targets);
        let cost = source_distance(board, color, &distance).min(12) as i32;
        let opportunities = Self::threat_cells(board, color, &beam, &distance)
            .len()
            .min(24) as i32;
        let reach = (beam.count * 400 / (board.cells() * 4)) as i32;
        let result = (cost, opportunities, reach);
        if self.potentials.len() < 131_072 {
            self.potentials.insert(key, result);
        }
        result
    }

    fn evaluate(&mut self, board: &mut Board) -> Result<i32, Interrupted> {
        let key = board.position_key();
        if let Some(&v) = self.evaluations.get(&key) {
            return Ok(v);
        }
        self.check()?;
        if self.winning_move(board, board.current)?.is_some() {
            return Ok(if board.current == self.root {
                WIN - 100
            } else {
                -WIN + 100
            });
        }
        let (our_cost, our_options, _) =
            self.potential(board, self.root, board.alive & !(1 << self.root));
        let mut enemy_cost = 12;
        let mut enemy_options = 0;
        let mut pressure = 0;
        let players = board.players.clone();
        for enemy in players
            .into_iter()
            .filter(|&c| c != self.root && board.active(c))
            .collect::<Vec<_>>()
        {
            self.check()?;
            let (cost, options, _) = self.potential(board, enemy, 1 << self.root);
            enemy_cost = enemy_cost.min(cost);
            enemy_options = enemy_options.max(options);
            for (attacker, defender, sign) in [(self.root, enemy, 1), (enemy, self.root, -1)] {
                if trace(board, attacker, false).hits & (1 << defender) == 0 {
                    continue;
                }
                let r = planning::resistance(board, attacker, defender, 4, || self.check().is_ok());
                self.check()?;
                if r.complete && r.saves == 0 && board.alive.count_ones() == 2 {
                    return Ok(sign * (WIN - 100));
                }
                // A threat with many responses is a tempo, not an almost-win.
                let saves = if r.complete {
                    r.saves.max(1)
                } else {
                    r.saves.max(4)
                };
                pressure += sign * (1000 + 4800 / (saves as i32));
            }
        }
        // Traversing extra empty cells is not progress. In a reflecting board
        // that geometric bonus used to overturn useful checks by a few points.
        let score = (enemy_cost - our_cost) * 1200 + (our_options - enemy_options) * 25 + pressure
            // Costs count future placements by each side, but the next player
            // gets to place first. Express that half-move in the same units;
            // otherwise each extra ply causes a spurious ~1200-point swing.
            + if board.alive.count_ones() == 2 && our_cost > 0 && enemy_cost > 0 {
                if board.current == self.root { 600 } else { -600 }
            } else { 0 };
        if self.evaluations.len() < 32_768 {
            self.evaluations.insert(key, score);
        }
        Ok(score)
    }
    fn search(
        &mut self,
        board: &mut Board,
        depth: i32,
        extension: u8,
        mut alpha: i32,
        mut beta: i32,
        ply: usize,
    ) -> Result<i32, Interrupted> {
        self.check()?;
        self.nodes += 1;
        if let Some(v) = self.terminal(board, ply) {
            return Ok(v);
        }
        let key = board.position_key();
        let mut preferred = None;
        if let Some(e) = self.table.get(&key) {
            preferred = e.best;
            if e.depth >= depth && e.extension >= extension {
                if e.bound == 0 {
                    return Ok(e.score);
                }
                if e.bound > 0 {
                    alpha = alpha.max(e.score);
                } else {
                    beta = beta.min(e.score);
                }
                if alpha >= beta {
                    return Ok(e.score);
                }
            }
        }
        if depth <= 0 {
            if extension == 0 {
                return self.evaluate(board);
            }
            let threatened = board.players.iter().any(|&c| {
                c != board.current
                    && board.active(c)
                    && trace(board, c, false).hits & (1 << board.current) != 0
            });
            if !threatened {
                return self.evaluate(board);
            }
        }
        let generated = self.moves(board, if depth <= 0 { 4 } else { 8 }, false)?;
        let mut moves = generated.choices;
        if moves.is_empty() {
            if generated.threatened && generated.complete && board.alive.count_ones() == 2 {
                return Ok(if board.current == self.root {
                    -WIN + ply as i32 + 1
                } else {
                    WIN - ply as i32 - 1
                });
            }
            return self.evaluate(board);
        }
        if let Some(m) = preferred {
            if let Some(i) = moves.iter().position(|r| r.action == m) {
                moves.swap(0, i);
            }
        }
        if moves[0].score >= WIN {
            return Ok(if board.current == self.root {
                WIN - ply as i32 - 2
            } else {
                -WIN + ply as i32 + 2
            });
        }
        let maximizing = board.current == self.root;
        let (original_alpha, original_beta) = (alpha, beta);
        let mut best = if maximizing { -LIMIT } else { LIMIT };
        let mut best_move = None;
        let old_current = board.current;
        let old_alive = board.alive;
        for candidate in moves {
            board.put(candidate.action, old_current);
            settle_next(board);
            let extra = if depth <= 0 {
                // A defense can itself give check. Do not evaluate that
                // countercheck as though its recipient already lost a tempo;
                // resolve it too, up to the bounded tactical extension.
                extension - 1
            } else {
                extension
            };
            let result = self.search(board, depth - 1, extra, alpha, beta, ply + 1);
            board.current = old_current;
            board.alive = old_alive;
            board.remove(candidate.action);
            let score = result?;
            if (maximizing && score > best) || (!maximizing && score < best) {
                best = score;
                best_move = Some(candidate.action);
            }
            if maximizing {
                alpha = alpha.max(best);
            } else {
                beta = beta.min(best);
            }
            if alpha >= beta {
                break;
            }
        }
        let bound = if best <= original_alpha {
            -1
        } else if best >= original_beta {
            1
        } else {
            0
        };
        if self.table.len() < 65_536 {
            self.table.insert(
                key,
                Entry {
                    depth,
                    extension,
                    score: best,
                    bound,
                    best: best_move,
                },
            );
        }
        Ok(best)
    }
    fn explain(&mut self, action: Move, threatened: bool) {
        self.reason = if self.stop_reason == "forced-win" {
            "这条攻击已经验证：对方没有能挡住它的合法落子。".into()
        } else if self.stop_reason == "single-defense" {
            "当前只有这一手能挡住下一次攻击。".into()
        } else if self.completed_score < -WIN / 2 {
            "当前搜索未找到摆脱强攻的路线，优先尝试阻断对方连接。".into()
        } else if threatened {
            "先挡住当前攻击，再比较反击与后续连接机会。".into()
        } else if self.prioritize_attack && self.root_attacks.contains(&action) {
            "无需防守，优先直接接通攻击，迫使对方应对；继续比较其防守与反击。".into()
        } else if self.anticipated.contains(&action) {
            "优先破坏对方下一步的强攻准备，再保留反击机会。".into()
        } else if self.reduced_connections.contains(&action) {
            "减少对方下一步接通攻击的候选位置，兼顾后续防守。".into()
        } else if let Some(plan) = self.root_plans.get(&action) {
            if plan.actions.len() == 1 {
                "接通攻击光路，迫使对方应对；对方仍可能挡住。".into()
            } else {
                format!(
                    "推进已验证的连接方案；还需 {} 面镜子接通，对方仍可干预。",
                    plan.actions.len() - 1
                )
            }
        } else {
            "比较对手的应对后，选择兼顾连接与防守的一手。".into()
        };
        if self.preferred_diagonal {
            self.reason.push_str("同类候选评分接近，优先选择斜镜。");
        }
        if !self.refuted.is_empty() && !self.refuted.contains_key(&action) {
            self.reason.push_str(&format!("已避开 {} 手被证明会遭连续强攻的候选。", self.refuted.len()));
        }
    }
    fn principal_line(&self, board: &Board, first: Move, limit: usize) -> Vec<Action> {
        let mut position = board.clone();
        let mut next = Some(first);
        let mut line = Vec::new();
        while let Some(action) = next {
            if line.len() >= limit || !position.available(action) {
                break;
            }
            line.push(Action::from_move(action, position.size));
            let color = position.current;
            position.put(action, color);
            settle_next(&mut position);
            if self.terminal(&position, line.len()).is_some() {
                break;
            }
            next = self
                .table
                .get(&position.position_key())
                .and_then(|entry| entry.best);
        }
        line
    }
    pub fn choose(&mut self, board: &mut Board, max_depth: u8) -> Option<Move> {
        let generated = self.moves(board, 12, true);
        let Ok(generated) = generated else {
            self.stop_reason = if self.nodes >= self.max_nodes {
                "node-limit"
            } else {
                "time-limit"
            };
            self.reason = "采用已完整验证不会立即失守的候选。".into();
            return self
                .fallback
                .filter(|_| self.fallback_safe)
                .map(|r| r.action);
        };
        let mut moves = generated.choices;
        self.root_attacks = moves
            .iter()
            .filter(|r| r.attack)
            .map(|r| r.action)
            .collect();
        moves.sort_by(|a, b| {
            self.priority(b.action, b.score)
                .cmp(&self.priority(a.action, a.score))
                .then_with(|| b.score.cmp(&a.score))
                .then_with(|| a.action.cmp(&b.action))
        });
        self.candidates = moves.len();
        if moves.is_empty() {
            if generated.threatened && generated.complete && board.alive.count_ones() == 2 {
                // The witness-path set is exhaustive for saving moves, not for
                // all legal moves. If every path intersection is illegal, the
                // old fallback stayed empty and reported an engine error.
                // Play a legal losing move so normal turn settlement ends play.
                if self.fallback.is_none() {
                    let actions: Vec<_> = board.all_moves().collect();
                    for action in actions {
                        board.put(action, board.current);
                        let legal = !board.encloses(board.current);
                        board.remove(action);
                        if legal {
                            self.fallback = Some(Ranked { action, score: -WIN, own_signature: 0, attack: false });
                            break;
                        }
                    }
                }
                if let Some(fallback) = &mut self.fallback {
                    fallback.score = -WIN;
                    self.stop_reason = "no-defense";
                    self.completed_score = -WIN;
                    self.reason = "已穷尽当前攻击的合法防守，无法挡住；按正常回合结算胜负。".into();
                    return Some(fallback.action);
                }
            }
            self.reason = "已检查所有即时防守，当前没有能守住的合法落子。".into();
            return self.fallback.map(|r| r.action);
        }
        self.fallback = Some(moves[0]);
        self.fallback_safe = true;
        let mut selected = moves[0].action;
        if moves[0].score >= WIN {
            self.stop_reason = "forced-win";
            self.completed_score = WIN;
            self.explain(selected, generated.threatened);
            return Some(selected);
        }
        if generated.threatened && generated.complete && moves.len() == 1 {
            self.stop_reason = "single-defense";
            self.explain(selected, true);
            return Some(selected);
        }
        if board.alive.count_ones() == 2 && max_depth >= 3 {
            // A small positive-only tactical pass can prove a forcing line
            // without searching every quiet development move. Its AND nodes
            // never prune legal defenses. Reserve most time for normal play.
            let remaining = (self.deadline - now_ms()).max(0.0);
            let mut forcing = ForcingSearch::new(
                board,
                (remaining * 0.2).min(4000.0),
                (self.max_nodes.saturating_sub(self.nodes) / 4).min(20_000),
                moves.iter().filter(|r| r.attack).map(|r| r.action).collect(),
            );
            let (proof, stats) = forcing.run(board, max_depth.div_ceil(2).min(4));
            self.nodes += stats.nodes;
            self.forcing = Some(stats);
            if let Some(proof) = proof {
                self.stop_reason = "forcing-win";
                self.completed_score = WIN;
                self.fallback = Some(Ranked { action: proof.action, score: WIN, own_signature: 0, attack: true });
                self.reason = format!(
                    "已验证连续强攻：无论对方怎样合法防守，至多再落 {} 面进攻镜即可形成无法化解的攻击。",
                    proof.turns
                );
                return Some(proof.action);
            }
        }
        if !generated.threatened {
            self.check_counterplay(board, &mut moves);
        }
        // Refresh the fallback before any iterative-search interruption. A
        // refuted candidate must not survive via the old heuristic incumbent.
        moves.sort_by(|a, b| {
            self.priority(b.action, b.score).cmp(&self.priority(a.action, a.score))
                .then_with(|| selection_score(b.action, b.score).cmp(&selection_score(a.action, a.score)))
                .then_with(|| a.action.cmp(&b.action))
        });
        self.fallback = Some(moves[0]);
        selected = moves[0].action;
        let old_current = board.current;
        let old_alive = board.alive;
        let min_depth = 4.max(self.minimum_depth);
        let mut previous = None;
        let mut previous_scores: HashMap<Move, i32> = HashMap::new();
        // Close candidate scores express uncertainty, not convergence. Require
        // the same choice and a stable value over three completed depths.
        let mut stable_rounds = 0;
        let mut previous_duration = 0.0;
        self.stop_reason = "depth-limit";
        for depth in 1..=max_depth {
            let started = now_ms();
            let mut results = Vec::new();
            let mut interrupted = false;
            // Fixed strategic width keeps cached bounds valid between iterations.
            // Full root windows make ties and score margins actual comparisons;
            // fail-low bounds must not decide orientation or convergence.
            let mut ordered = moves.clone();
            // Finish the incumbent first, so an interrupted iteration can
            // compare challengers against it at the SAME depth.
            ordered.sort_by_key(|candidate| candidate.action != selected);
            for candidate in &ordered {
                if let Some(&turns) = self.refuted.get(&candidate.action) {
                    results.push((candidate.action, -WIN + 2 * i32::from(turns), candidate.score));
                    continue;
                }
                if self.check().is_err() {
                    interrupted = true;
                    break;
                }
                board.put(candidate.action, old_current);
                settle_next(board);
                let result = self.search(board, depth as i32 - 1, 3, -LIMIT, LIMIT, 1);
                board.current = old_current;
                board.alive = old_alive;
                board.remove(candidate.action);
                match result {
                    Ok(score) => results.push((candidate.action, score, candidate.score)),
                    Err(_) => {
                        interrupted = true;
                        break;
                    }
                }
            }
            results.sort_by(|a, b| {
                self.priority(b.0, b.1)
                    .cmp(&self.priority(a.0, a.1))
                    .then_with(|| selection_score(b.0, b.1).cmp(&selection_score(a.0, a.1)))
                    .then_with(|| matches!(b.0, Move::Diag(..)).cmp(&matches!(a.0, Move::Diag(..))))
                    .then_with(|| b.2.cmp(&a.2))
                    .then_with(|| a.0.cmp(&b.0))
            });
            if interrupted {
                // Keep a completed comparison against the previous choice.
                // Never replace it using a deep score versus its old shallow
                // score; it must itself have finished at this depth first.
                if self.completed_depth > 0 && results.iter().any(|r| r.0 == selected) {
                    if let Some(&(action, score, _)) = results.first() {
                        selected = action;
                        self.selection_depth = depth;
                        self.completed_score = score;
                        self.preferred_diagonal = matches!(action, Move::Diag(..))
                            && results.iter().any(|r| {
                                !matches!(r.0, Move::Diag(..))
                                    && r.1 > score
                                    && self.priority(r.0, r.1) == self.priority(action, score)
                            });
                    }
                }
                if !results.is_empty() {
                    self.partial_iteration = Some(SearchIteration {
                        depth,
                        candidates: results
                            .iter()
                            .map(|&(action, score, ordering_score)| SearchCandidate {
                                action: Action::from_move(action, board.size),
                                score,
                                selection_score: selection_score(action, score),
                                selection_priority: self.priority(action, score),
                                direct_attack: self.root_attacks.contains(&action),
                                ordering_score,
                                line: self.principal_line(board, action, depth as usize + 3),
                            })
                            .collect(),
                    });
                }
                self.stop_reason = if self.nodes >= self.max_nodes {
                    "node-limit"
                } else {
                    "time-limit"
                };
                break;
            }
            self.iterations.push(SearchIteration {
                depth,
                candidates: results
                    .iter()
                    .map(|&(action, score, ordering_score)| SearchCandidate {
                        action: Action::from_move(action, board.size),
                        score,
                        selection_score: selection_score(action, score),
                        selection_priority: self.priority(action, score),
                        direct_attack: self.root_attacks.contains(&action),
                        ordering_score,
                        line: self.principal_line(board, action, depth as usize + 3),
                    })
                    .collect(),
            });
            if let Some(&(action, score, _)) = results.first() {
                selected = action;
                self.completed_depth = depth;
                self.selection_depth = depth;
                self.completed_score = score;
                self.preferred_diagonal = matches!(action, Move::Diag(..))
                    && results.iter().any(|r| {
                        !matches!(r.0, Move::Diag(..))
                            && r.1 > score
                            && self.priority(r.0, r.1) == self.priority(action, score)
                    });
            }
            let stable = previous.is_some_and(|(action, score): (Move, i32)| {
                action == selected && (score - self.completed_score).abs() <= 180
            }) && results.iter().all(|(action, score, _)| {
                previous_scores
                    .get(action)
                    .is_some_and(|old| (old - score).abs() <= 180)
            });
            stable_rounds = if stable { stable_rounds + 1 } else { 0 };
            if depth >= min_depth && self.completed_score.abs() < WIN / 2 && stable_rounds >= 2 {
                self.stop_reason = "stable";
                break;
            }
            let duration = now_ms() - started;
            let factor = if previous_duration > 0.0 {
                (duration / previous_duration).clamp(2.0, 12.0)
            } else {
                4.0
            };
            if depth < max_depth && depth >= 3 && duration * factor > self.deadline - now_ms() {
                self.stop_reason = "time-limit";
                break;
            }
            previous = Some((selected, self.completed_score));
            previous_scores = results
                .iter()
                .map(|&(action, score, _)| (action, score))
                .collect();
            previous_duration = duration;
        }
        self.explain(selected, generated.threatened);
        Some(selected)
    }
    pub fn stats(&mut self, mode: &str) -> Stats {
        Stats {
            nodes: self.nodes,
            depth: self.completed_depth,
            selection_depth: self.selection_depth,
            elapsed_ms: now_ms() - self.start,
            score: if self.completed_depth > 0 {
                self.completed_score
            } else {
                self.fallback.map_or(0, |r| r.score)
            },
            mode: mode.into(),
            safe: self.fallback_safe,
            defense_complete: self.defense_complete,
            candidates: self.candidates,
            plans: self.root_plans.len(),
            stop_reason: self.stop_reason.into(),
            reason: self.reason.clone(),
            forcing: self.forcing.take(),
            counterplay: std::mem::take(&mut self.counterplay),
            iterations: std::mem::take(&mut self.iterations),
            partial_iteration: self.partial_iteration.take(),
        }
    }

    fn priority(&self, action: Move, score: i32) -> u8 {
        if self.refuted.contains_key(&action) {
            return 0;
        }
        selection_priority(
            score,
            self.prioritize_attack && self.root_attacks.contains(&action),
        )
    }
}
