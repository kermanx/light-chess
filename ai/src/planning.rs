use crate::board::{Board, Move};
use crate::optics::{additions, defenses, trace, Connections, Trace, INF};
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct Plan {
    pub actions: Vec<Move>,
    pub hops: u32,
    pub exposure: usize,
}

impl Plan {
    pub fn score(&self) -> i32 {
        // Length counts actual placements, not laser distance. Exposure counts
        // future placements already on an opponent beam. Hops only break ties.
        12_000
            - self.actions.len() as i32 * 1800
            - self.exposure as i32 * 120
            - self.hops.min(120) as i32
    }
}

pub fn cell_of(board: &Board, action: Move) -> usize {
    match action {
        Move::Diag(cell, _) => cell,
        Move::Horizontal(i) => i.min(board.cells() - 1),
        Move::Vertical(i) => {
            (i / (board.size + 1)) * board.size + (i % (board.size + 1)).min(board.size - 1)
        }
    }
}

/// A heuristic grouping, never an equivalence proof: keep routes on different
/// sides of the target instead of filling the shortlist with adjacent cells.
pub fn region(board: &Board, color: u8, action: Move) -> usize {
    let cell = cell_of(board, action);
    let (x, y) = (cell % board.size, cell / board.size);
    let target = board
        .homes
        .iter()
        .enumerate()
        .filter(|(c, _)| *c != color as usize && board.active(*c as u8))
        .filter_map(|(_, h)| *h)
        .min_by_key(|h| x.abs_diff(h.x) + y.abs_diff(h.y));
    target.map_or(0, |h| {
        let side = |a: usize, b: usize| {
            if a < b {
                0
            } else if a == b {
                1
            } else {
                2
            }
        };
        side(x, h.x) * 3 + side(y, h.y)
    })
}

pub fn proposals(
    board: &Board,
    color: u8,
    beam: &Trace,
    enemies: &[(u8, Trace)],
    map: &Connections,
) -> Vec<Plan> {
    let mut by_first: HashMap<Move, Plan> = HashMap::new();
    for (cell, &dirs) in beam.seen.iter().enumerate() {
        for d in 0..4 {
            if dirs & (1 << d) == 0 {
                continue;
            }
            additions(board, color, cell * 4 + d, |t, first| {
                if map.distance[t.to] == INF
                    || map.distance[t.to] > 5
                    || beam.seen[t.to / 4] & (1 << (t.to % 4)) != 0
                {
                    return;
                }
                let Some(tail) = map.route(t.to, 5) else {
                    return;
                };
                let mut actions = vec![first];
                for m in tail {
                    if !actions.contains(&m) {
                        actions.push(m);
                    }
                }
                let exposure = actions
                    .iter()
                    .skip(1)
                    .filter(|&&m| {
                        let c = cell_of(board, m);
                        enemies.iter().any(|(e, t)| *e != color && t.seen[c] != 0)
                    })
                    .count();
                let plan = Plan {
                    actions,
                    hops: map.hops[t.to],
                    exposure,
                };
                let entry = by_first.entry(first).or_insert_with(|| plan.clone());
                if plan.score() > entry.score() {
                    *entry = plan;
                }
            });
        }
    }
    let mut out: Vec<_> = by_first.into_values().collect();
    out.sort_by(|a, b| {
        b.score()
            .cmp(&a.score())
            .then_with(|| a.actions[0].cmp(&b.actions[0]))
    });
    out
}

/// Validate a proposed sequence with real rules, undoing every placement even on
/// failure. Other players do not move here: this is a plan, not a forced-win proof.
pub fn verify(board: &mut Board, color: u8, plan: &Plan) -> bool {
    let mut placed = Vec::new();
    let mut legal = true;
    for &action in &plan.actions {
        if !board.available(action) {
            legal = false;
            break;
        }
        board.put(action, color);
        placed.push(action);
        if board.encloses(color) {
            legal = false;
            break;
        }
    }
    let connects = legal && trace(board, color, false).hits & board.alive & !(1 << color) != 0;
    for action in placed.into_iter().rev() {
        board.remove(action);
    }
    connects
}

/// Count ways to stop an actual attack, rather than counting overlapping paths.
/// A limit is a lower bound on defenses; zero is meaningful only when complete.
pub struct Resistance {
    pub saves: usize,
    pub complete: bool,
}

pub fn resistance(
    board: &mut Board,
    attacker: u8,
    defender: u8,
    limit: usize,
    mut keep_going: impl FnMut() -> bool,
) -> Resistance {
    let beam = trace(board, attacker, true);
    if beam.hits & (1 << defender) == 0 {
        return Resistance {
            saves: 0,
            complete: false,
        };
    }
    let mut result = Resistance {
        saves: 0,
        complete: true,
    };
    for action in defenses(board, &beam, defender) {
        if !keep_going() {
            result.complete = false;
            break;
        }
        board.put(action, defender);
        let safe =
            !board.encloses(defender) && trace(board, attacker, false).hits & (1 << defender) == 0;
        board.remove(action);
        if safe {
            result.saves += 1;
            if result.saves >= limit {
                result.complete = false;
                break;
            }
        }
    }
    result
}
