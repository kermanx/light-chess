//! Positive-only AND/OR search for a chain of checks. Attack choices may be
//! incomplete; a proof must cover EVERY legal defense, including counterchecks.
//! Failure or interruption means unknown, never a loss or a forced win.
use crate::board::{Board, Move};
use crate::optics::{additions, connection_distances, defenses, trace};
use crate::{clock_now, Action};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

#[derive(Clone)]
pub struct Proof {
    pub action: Move,
    pub replies: Vec<(Move, Arc<Proof>)>,
    /// Worst-case number of attacker placements, including this attack.
    pub turns: u8,
}

#[derive(Serialize)]
pub struct ProofRecord {
    pub action: Action,
    pub replies: Vec<ReplyRecord>,
}

#[derive(Serialize)]
pub struct ReplyRecord {
    pub action: Action,
    pub continuation: ProofRecord,
}

impl Proof {
    pub fn record(&self, size: usize) -> ProofRecord {
        ProofRecord {
            action: Action::from_move(self.action, size),
            replies: self
                .replies
                .iter()
                .map(|(action, next)| ReplyRecord {
                    action: Action::from_move(*action, size),
                    continuation: next.record(size),
                })
                .collect(),
        }
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForcingStats {
    pub nodes: u64,
    pub elapsed_ms: f64,
    pub completed_depth: u8,
    pub attempted_depth: u8,
    /// "unknown" includes a fully searched bounded attack tree, not all play.
    pub status: &'static str,
    pub winning_turns: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proof: Option<ProofRecord>,
}

#[derive(Debug)]
struct Interrupted;

pub struct ForcingSearch {
    attacker: u8,
    defender: u8,
    deadline: f64,
    max_nodes: u64,
    pub nodes: u64,
    // Negative entries only exhaust the generated checks within this depth.
    // They are not shared with strategic evaluation or used to declare a loss.
    cache: HashMap<(u64, u8), Option<Arc<Proof>>>,
    preferred: Vec<Move>,
}

impl ForcingSearch {
    pub fn new(board: &Board, budget_ms: f64, max_nodes: u64, preferred: Vec<Move>) -> Self {
        Self {
            attacker: board.current,
            defender: board.next_alive(board.current),
            deadline: clock_now() + budget_ms,
            max_nodes,
            nodes: 0,
            cache: HashMap::new(),
            preferred,
        }
    }

    fn check(&self) -> Result<(), Interrupted> {
        if self.nodes >= self.max_nodes || clock_now() >= self.deadline {
            Err(Interrupted)
        } else {
            Ok(())
        }
    }

    fn visit(&mut self) -> Result<(), Interrupted> {
        self.check()?;
        self.nodes += 1;
        Ok(())
    }

    fn attacks(&self, board: &Board, root: bool) -> Vec<Move> {
        let beam = trace(board, self.attacker, false);
        let distance = connection_distances(board, self.attacker, 1 << self.defender);
        let mut actions = HashSet::new();
        for (cell, &dirs) in beam.seen.iter().enumerate() {
            for d in 0..4 {
                if dirs & (1 << d) != 0 {
                    additions(board, self.attacker, cell * 4 + d, |t, action| {
                        if distance[t.to] == 0 {
                            actions.insert(action);
                        }
                    });
                }
            }
        }
        let mut actions: Vec<_> = actions.into_iter().collect();
        actions.sort_by_key(|action| {
            (
                if root {
                    self.preferred
                        .iter()
                        .position(|m| m == action)
                        .unwrap_or(usize::MAX)
                } else {
                    0
                },
                !matches!(action, Move::Diag(..)),
                *action,
            )
        });
        actions
    }

    fn solve(
        &mut self,
        board: &mut Board,
        depth: u8,
        root: bool,
    ) -> Result<Option<Arc<Proof>>, Interrupted> {
        self.check()?;
        let key = (board.position_key(), depth);
        if let Some(proof) = self.cache.get(&key) {
            return Ok(proof.clone());
        }
        let actions = self.attacks(board, root);
        for action in actions {
            self.visit()?;
            board.put(action, self.attacker);
            let result = self.after_attack(board, action, depth);
            board.remove(action);
            // Always undo before propagating cancellation or a successful proof.
            if let Some(proof) = result? {
                let proof = Arc::new(proof);
                self.cache.insert(key, Some(proof.clone()));
                return Ok(Some(proof));
            }
        }
        self.cache.insert(key, None);
        Ok(None)
    }

    fn after_attack(
        &mut self,
        board: &mut Board,
        action: Move,
        depth: u8,
    ) -> Result<Option<Proof>, Interrupted> {
        if board.encloses(self.attacker)
            || trace(board, self.defender, false).hits & (1 << self.attacker) != 0
        {
            return Ok(None);
        }
        let beam = trace(board, self.attacker, true);
        if beam.hits & (1 << self.defender) == 0 {
            return Ok(None);
        }
        let mut replies = Vec::new();
        let mut turns = 1;
        let mut candidates = defenses(board, &beam, self.defender);
        // Test passive cuts early: they often stop the entire forcing sequence.
        candidates.sort_by_key(|m| (matches!(m, Move::Diag(..)), *m));
        for defense in candidates {
            self.visit()?;
            board.put(defense, self.defender);
            let safe = !board.encloses(self.defender)
                && trace(board, self.attacker, false).hits & (1 << self.defender) == 0;
            let result = if !safe || depth == 1 {
                Ok(None)
            } else {
                self.solve(board, depth - 1, false)
            };
            board.remove(defense);
            if !safe {
                continue;
            }
            match result? {
                Some(next) => {
                    turns = turns.max(next.turns + 1);
                    replies.push((defense, next));
                }
                // One legal defense without a proved continuation refutes
                // this proof attempt, even if every other defense loses.
                None => return Ok(None),
            }
        }
        Ok(Some(Proof {
            action,
            replies,
            turns,
        }))
    }

    pub fn run(&mut self, board: &mut Board, max_depth: u8) -> (Option<Arc<Proof>>, ForcingStats) {
        let start = clock_now();
        let mut stats = ForcingStats {
            status: "unknown",
            ..Default::default()
        };
        let mut proof = None;
        // The fixed attacker/defender model is sound only for a living duel.
        if board.alive.count_ones() == 2 && board.active(self.attacker) {
            for depth in 1..=max_depth {
                stats.attempted_depth = depth;
                match self.solve(board, depth, true) {
                    Ok(found) => {
                        stats.completed_depth = depth;
                        if let Some(found) = found {
                            stats.status = "proven";
                            stats.winning_turns = Some(found.turns);
                            stats.proof = Some(found.record(board.size));
                            proof = Some(found);
                            break;
                        }
                    }
                    Err(_) => {
                        stats.status = "budget";
                        break;
                    }
                }
            }
        }
        stats.nodes = self.nodes;
        stats.elapsed_ms = clock_now() - start;
        (proof, stats)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Request;

    fn position(fixture: &str) -> Board {
        let data: serde_json::Value = serde_json::from_str(fixture).unwrap();
        serde_json::from_value::<Request>(data["request"].clone())
            .unwrap()
            .into_board()
            .unwrap()
    }

    fn unchanged(before: &Board, after: &Board) {
        assert_eq!(before.position_key(), after.position_key());
        assert_eq!(before.horizontal, after.horizontal);
        assert_eq!(before.vertical, after.vertical);
        assert_eq!(before.diagonals, after.diagonals);
        assert_eq!((before.current, before.alive), (after.current, after.alive));
    }

    #[test]
    fn proves_a_chain_across_every_defense_and_restores_the_board() {
        let mut board = position(include_str!("../fixtures/forcing-chain.json"));
        let before = board.clone();
        let mut solver = ForcingSearch::new(&board, 30_000.0, 100_000, vec![]);
        let (proof, stats) = solver.run(&mut board, 2);
        let proof = proof.unwrap();
        assert_eq!(stats.status, "proven");
        assert_eq!(proof.turns, 2);
        assert_eq!(proof.replies.len(), 2);
        assert!(proof
            .replies
            .iter()
            .all(|(_, next)| next.replies.is_empty()));
        unchanged(&before, &board);
    }

    #[test]
    fn partial_defense_coverage_and_depth_limits_never_become_a_proof() {
        let mut board = position(include_str!("../fixtures/forcing-chain.json"));
        let before = board.clone();
        let mut one_turn = ForcingSearch::new(&board, 30_000.0, 100_000, vec![]);
        let (proof, stats) = one_turn.run(&mut board, 1);
        assert!(proof.is_none());
        assert_eq!(stats.status, "unknown");
        let mut complete = ForcingSearch::new(&board, 30_000.0, 100_000, vec![]);
        let (_, full) = complete.run(&mut board, 2);
        // Interrupt at every placement before the whole proof was covered,
        // including during recursive continuations and the last defense.
        for limit in 0..full.nodes {
            let mut solver = ForcingSearch::new(&board, 30_000.0, limit, vec![]);
            let (proof, stats) = solver.run(&mut board, 2);
            assert!(proof.is_none(), "partial proof accepted at limit {limit}");
            assert_eq!(stats.status, "budget");
            unchanged(&before, &board);
        }
        let mut expired = ForcingSearch::new(&board, 0.0, 100_000, vec![]);
        assert!(expired.run(&mut board, 4).0.is_none());
        unchanged(&before, &board);
    }

    #[test]
    fn a_passive_block_that_stops_all_checks_is_not_a_forcing_win() {
        let mut board = position(include_str!("../fixtures/attack-initiative.json"));
        board.put(Move::Diag(2 * 16 + 13, 0), 1);
        board.put(Move::Vertical(2 * 17 + 13), 0);
        let before = board.clone();
        let mut solver = ForcingSearch::new(&board, 30_000.0, 100_000, vec![]);
        let (proof, stats) = solver.run(&mut board, 3);
        assert!(proof.is_none());
        assert_eq!(stats.status, "unknown");
        unchanged(&before, &board);
    }
}
