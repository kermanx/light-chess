use crate::board::{Board, Move, NONE, REFLECT};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, VecDeque};

#[derive(Clone, Copy)]
pub struct Transition {
    pub to: usize,
    pub edge: Move,
}

/// Process the outgoing edge after the cell's diagonal interaction.
pub fn along(board: &Board, color: u8, cell: usize, dir: usize, mut visit: impl FnMut(Transition)) {
    let edge = board.edge(cell, dir);
    let mirror = board.value(edge);
    match board.neighbor(cell, dir) {
        None => visit(Transition {
            to: cell * 4 + (dir ^ 2),
            edge,
        }),
        Some(next) => {
            if mirror == 0 || mirror == color + 1 {
                visit(Transition {
                    to: next * 4 + dir,
                    edge,
                });
            }
            if mirror != 0 {
                visit(Transition {
                    to: cell * 4 + (dir ^ 2),
                    edge,
                });
            }
        }
    }
}

pub fn transitions(board: &Board, color: u8, state: usize, mut visit: impl FnMut(Transition)) {
    let cell = state / 4;
    let dir = state % 4;
    let home = board.home_at[cell];
    if home != 0 && home != color + 1 {
        return;
    }
    let diag = board.diagonals[cell];
    if diag == 0 || (diag - 1) / 2 == color {
        along(board, color, cell, dir, &mut visit);
    }
    if diag != 0 {
        along(
            board,
            color,
            cell,
            REFLECT[((diag - 1) % 2) as usize][dir],
            visit,
        );
    }
}

pub struct Trace {
    pub seen: Vec<u8>,
    pub hits: u8,
    pub hit_states: [usize; 4],
    pub parent: Vec<usize>,
    pub via: Vec<Option<Move>>,
    pub count: usize,
}

pub fn trace(board: &Board, color: u8, paths: bool) -> Trace {
    let states = board.cells() * 4;
    let mut result = Trace {
        seen: vec![0; board.cells()],
        hits: 0,
        hit_states: [NONE; 4],
        parent: if paths {
            vec![NONE; states]
        } else {
            Vec::new()
        },
        via: if paths {
            vec![None; states]
        } else {
            Vec::new()
        },
        count: 0,
    };
    let Some(home) = board.homes[color as usize] else {
        return result;
    };
    let source = home.y * board.size + home.x;
    let mut queue = Vec::with_capacity(states.min(4096));
    result.seen[source] = 15;
    for d in 0..4 {
        queue.push(source * 4 + d);
    }
    let mut head = 0;
    while head < queue.len() {
        let state = queue[head];
        head += 1;
        let cell = state / 4;
        let target = board.home_at[cell];
        if target != 0 && target != color + 1 {
            result.hits |= 1 << (target - 1);
            if result.hit_states[(target - 1) as usize] == NONE {
                result.hit_states[(target - 1) as usize] = state;
            }
            continue;
        }
        transitions(board, color, state, |t| {
            let bit = 1 << (t.to % 4);
            if result.seen[t.to / 4] & bit == 0 {
                result.seen[t.to / 4] |= bit;
                if paths {
                    result.parent[t.to] = state;
                    result.via[t.to] = Some(t.edge);
                }
                queue.push(t.to);
            }
        });
    }
    result.count = queue.len();
    result
}

/// Every saving move must intersect this witness path. Both diagonal orientations
/// and every crossed empty edge are retained; verifying just this path is NOT enough.
pub fn defenses(board: &Board, beam: &Trace, target: u8) -> Vec<Move> {
    let mut out = Vec::new();
    let mut state = beam.hit_states[target as usize];
    while state != NONE {
        let cell = state / 4;
        for ori in 0..2 {
            let m = Move::Diag(cell, ori);
            if board.available(m) {
                out.push(m);
            }
        }
        if let Some(m) = beam.via[state] {
            if board.available(m) {
                out.push(m);
            }
        }
        state = beam.parent[state];
    }
    out.sort_unstable();
    out.dedup();
    out
}

pub const INF: u16 = u16::MAX;

/// Outgoing paths made possible by one new mirror. Existing paths are separate:
/// adding our mirror never removes one of our own optical transitions.
pub fn additions(board: &Board, color: u8, state: usize, mut visit: impl FnMut(Transition, Move)) {
    let cell = state / 4;
    let dir = state % 4;
    let home = board.home_at[cell];
    if home != 0 && home != color + 1 {
        return;
    }
    if board.diagonals[cell] == 0 && home == 0 {
        for (ori, refl) in REFLECT.iter().enumerate() {
            along(board, color, cell, refl[dir], |t| {
                visit(t, Move::Diag(cell, ori as u8))
            });
        }
    }
    let mut edge = |d| {
        let action = board.edge(cell, d);
        if board.available(action) {
            visit(
                Transition {
                    to: cell * 4 + (d ^ 2),
                    edge: action,
                },
                action,
            );
        }
    };
    let diag = board.diagonals[cell];
    if diag == 0 || (diag - 1) / 2 == color {
        edge(dir);
    }
    if diag != 0 {
        edge(REFLECT[((diag - 1) % 2) as usize][dir]);
    }
}

pub struct Connections {
    pub distance: Vec<u16>,
    pub hops: Vec<u32>,
    next: Vec<Option<(usize, Option<Move>)>>,
}

impl Connections {
    /// Recover concrete placements. The caller must validate conflicting mirrors,
    /// enclosure, and the final beam; these are paths in a relaxed graph.
    pub fn route(&self, mut state: usize, limit: usize) -> Option<Vec<Move>> {
        if self.distance[state] == INF || self.distance[state] as usize > limit {
            return None;
        }
        let mut out = Vec::new();
        while let Some((to, action)) = self.next[state] {
            if let Some(m) = action {
                if !out.contains(&m) {
                    out.push(m);
                }
                if out.len() > limit {
                    return None;
                }
            }
            // Lexicographic shortest paths strictly decrease (cost, hops), so
            // zero-cost reflection cycles cannot appear in the recovered path.
            debug_assert!(
                (self.distance[to], self.hops[to]) < (self.distance[state], self.hops[state])
            );
            state = to;
        }
        Some(out)
    }
}

/// Relaxed connection cost in the TRANSPOSE of our own-color transition graph.
/// Virtual turns are hints, not a proof of legal distinct mirror placements.
pub fn connection_distances(board: &Board, color: u8, targets: u8) -> Vec<u16> {
    // Leaf evaluation needs costs only. Keep this linear 0-1 BFS separate from
    // route reconstruction's lexicographic Dijkstra (which also minimizes hops).
    let states = board.cells() * 4;
    let mut links = Vec::with_capacity(states * 4);
    let mut offsets = vec![0usize; states + 1];
    for from in 0..states {
        transitions(board, color, from, |t| {
            links.push((from, t.to, 0u16));
            offsets[t.to + 1] += 1;
        });
        additions(board, color, from, |t, _| {
            links.push((from, t.to, 1u16));
            offsets[t.to + 1] += 1;
        });
    }
    for i in 1..=states {
        offsets[i] += offsets[i - 1];
    }
    let mut cursor = offsets.clone();
    let mut predecessors = vec![(0usize, 0u16); links.len()];
    for (from, to, cost) in links {
        predecessors[cursor[to]] = (from, cost);
        cursor[to] += 1;
    }
    let mut distance = vec![INF; states];
    let mut queue = VecDeque::new();
    for color in 0..4 {
        if targets & (1 << color) == 0 {
            continue;
        }
        if let Some(h) = board.homes[color] {
            for d in 0..4 {
                let s = (h.y * board.size + h.x) * 4 + d;
                distance[s] = 0;
                queue.push_back(s);
            }
        }
    }
    while let Some(to) = queue.pop_front() {
        for &(from, cost) in &predecessors[offsets[to]..offsets[to + 1]] {
            let candidate = distance[to].saturating_add(cost);
            if candidate < distance[from] {
                distance[from] = candidate;
                if cost == 0 {
                    queue.push_front(from);
                } else {
                    queue.push_back(from);
                }
            }
        }
    }
    distance
}

pub fn connections(board: &Board, color: u8, targets: u8) -> Connections {
    let states = board.cells() * 4;
    let mut links = Vec::with_capacity(states * 4);
    let mut offsets = vec![0usize; states + 1];
    for from in 0..states {
        let cell = from / 4;
        let home = board.home_at[cell];
        if home != 0 && home != color + 1 {
            continue;
        }
        transitions(board, color, from, |t| {
            links.push((from, t.to, None));
            offsets[t.to + 1] += 1;
        });
        additions(board, color, from, |t, action| {
            links.push((from, t.to, Some(action)));
            offsets[t.to + 1] += 1;
        });
    }
    for i in 1..=states {
        offsets[i] += offsets[i - 1];
    }
    let mut cursor = offsets.clone();
    let mut predecessors = vec![(0usize, None); links.len()];
    for (from, to, action) in links {
        predecessors[cursor[to]] = (from, action);
        cursor[to] += 1;
    }
    let mut distance = vec![INF; states];
    let mut hops = vec![u32::MAX; states];
    let mut next = vec![None; states];
    let mut queue = BinaryHeap::new();
    for c in 0..4 {
        if targets & (1 << c) == 0 {
            continue;
        }
        if let Some(h) = board.homes[c] {
            for d in 0..4 {
                let s = (h.y * board.size + h.x) * 4 + d;
                distance[s] = 0;
                hops[s] = 0;
                queue.push(Reverse((0u16, 0u32, s)));
            }
        }
    }
    while let Some(Reverse((base, steps, to))) = queue.pop() {
        if (base, steps) != (distance[to], hops[to]) {
            continue;
        }
        for &(from, action) in &predecessors[offsets[to]..offsets[to + 1]] {
            let candidate = (
                base.saturating_add(u16::from(action.is_some())),
                steps.saturating_add(1),
            );
            if candidate < (distance[from], hops[from]) {
                (distance[from], hops[from]) = candidate;
                next[from] = Some((to, action));
                queue.push(Reverse((candidate.0, candidate.1, from)));
            }
        }
    }
    Connections {
        distance,
        hops,
        next,
    }
}

pub fn source_distance(board: &Board, color: u8, distance: &[u16]) -> u16 {
    board.homes[color as usize]
        .map(|h| {
            let c = (h.y * board.size + h.x) * 4;
            *distance[c..c + 4].iter().min().unwrap()
        })
        .unwrap_or(INF)
}

pub fn settle_next(board: &mut Board) {
    board.current = board.next_alive(board.current);
    let hits = trace(board, board.current, false).hits;
    board.alive &= !hits;
}
