use serde::{Deserialize, Serialize};

pub const NONE: usize = usize::MAX;
pub const REFLECT: [[usize; 4]; 2] = [[3, 2, 1, 0], [1, 0, 3, 2]];

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Home {
    pub x: usize,
    pub y: usize,
    pub dir: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Move {
    Diag(usize, u8),
    Horizontal(usize),
    Vertical(usize),
}

#[derive(Clone)]
pub struct Board {
    pub size: usize,
    pub horizontal: Vec<u8>,
    pub vertical: Vec<u8>,
    pub diagonals: Vec<u8>,
    pub homes: [Option<Home>; 4],
    pub home_at: Vec<u8>,
    pub players: Vec<u8>,
    pub current: u8,
    pub alive: u8,
    pub hash: u64,
}

pub fn mix(mut v: u64) -> u64 {
    v = (v ^ (v >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    v = (v ^ (v >> 27)).wrapping_mul(0x94d049bb133111eb);
    v ^ (v >> 31)
}

impl Board {
    pub fn cells(&self) -> usize {
        self.size * self.size
    }
    pub fn active(&self, color: u8) -> bool {
        self.alive & (1 << color) != 0
    }
    pub fn neighbor(&self, cell: usize, dir: usize) -> Option<usize> {
        let x = cell % self.size;
        let y = cell / self.size;
        match dir {
            0 if x + 1 < self.size => Some(cell + 1),
            1 if y + 1 < self.size => Some(cell + self.size),
            2 if x > 0 => Some(cell - 1),
            3 if y > 0 => Some(cell - self.size),
            _ => None,
        }
    }
    pub fn edge(&self, cell: usize, dir: usize) -> Move {
        let x = cell % self.size;
        let y = cell / self.size;
        match dir {
            0 => Move::Vertical(y * (self.size + 1) + x + 1),
            1 => Move::Horizontal((y + 1) * self.size + x),
            2 => Move::Vertical(y * (self.size + 1) + x),
            _ => Move::Horizontal(y * self.size + x),
        }
    }
    pub fn value(&self, m: Move) -> u8 {
        match m {
            Move::Diag(c, _) => self.diagonals[c],
            Move::Horizontal(i) => self.horizontal[i],
            Move::Vertical(i) => self.vertical[i],
        }
    }
    pub fn available(&self, m: Move) -> bool {
        match m {
            Move::Diag(c, ori) => {
                c < self.cells() && ori < 2 && self.home_at[c] == 0 && self.diagonals[c] == 0
            }
            Move::Horizontal(i) => {
                i >= self.size && i < self.size * self.size && self.horizontal[i] == 0
            }
            Move::Vertical(i) => {
                i < self.vertical.len()
                    && i % (self.size + 1) > 0
                    && i % (self.size + 1) < self.size
                    && self.vertical[i] == 0
            }
        }
    }
    fn piece_hash(m: Move, value: u8) -> u64 {
        let (kind, id) = match m {
            Move::Diag(c, _) => (1u64, c),
            Move::Horizontal(i) => (2, i),
            Move::Vertical(i) => (3, i),
        };
        mix((id as u64).wrapping_mul(37) ^ (kind << 52) ^ ((value as u64) << 44))
    }
    pub fn put(&mut self, m: Move, color: u8) {
        debug_assert!(self.available(m));
        let value = match m {
            Move::Diag(_, ori) => 1 + color * 2 + ori,
            _ => color + 1,
        };
        match m {
            Move::Diag(c, _) => self.diagonals[c] = value,
            Move::Horizontal(i) => self.horizontal[i] = value,
            Move::Vertical(i) => self.vertical[i] = value,
        }
        self.hash ^= Self::piece_hash(m, value);
    }
    pub fn remove(&mut self, m: Move) {
        self.hash ^= Self::piece_hash(m, self.value(m));
        match m {
            Move::Diag(c, _) => self.diagonals[c] = 0,
            Move::Horizontal(i) => self.horizontal[i] = 0,
            Move::Vertical(i) => self.vertical[i] = 0,
        }
    }
    pub fn refresh_hash(&mut self) {
        self.hash = mix(self.size as u64);
        for (i, &v) in self.diagonals.iter().enumerate() {
            if v != 0 {
                self.hash ^= Self::piece_hash(Move::Diag(i, (v - 1) % 2), v);
            }
        }
        for (i, &v) in self.horizontal.iter().enumerate() {
            if v != 0 {
                self.hash ^= Self::piece_hash(Move::Horizontal(i), v);
            }
        }
        for (i, &v) in self.vertical.iter().enumerate() {
            if v != 0 {
                self.hash ^= Self::piece_hash(Move::Vertical(i), v);
            }
        }
        for (c, h) in self.homes.iter().enumerate() {
            if let Some(h) = h {
                self.hash ^=
                    mix(0x1000000000000000 | ((c as u64) << 48) | ((h.y * self.size + h.x) as u64));
            }
        }
    }
    pub fn position_key(&self) -> u64 {
        self.hash ^ mix(0x8000000000000000 | ((self.alive as u64) << 8) | self.current as u64)
    }
    pub fn next_alive(&self, color: u8) -> u8 {
        let i = self.players.iter().position(|&c| c == color).unwrap();
        for step in 1..=self.players.len() {
            let c = self.players[(i + step) % self.players.len()];
            if self.active(c) {
                return c;
            }
        }
        color
    }
    pub fn all_moves(&self) -> impl Iterator<Item = Move> + '_ {
        (0..self.cells())
            .flat_map(|c| [Move::Diag(c, 0), Move::Diag(c, 1)])
            .chain((self.size..self.cells()).map(Move::Horizontal))
            .chain((0..self.vertical.len()).map(Move::Vertical))
            .filter(|&m| self.available(m))
    }
    /// Same four-triangle flood fill as game.ts. Only live homes constrain enclosure;
    /// eliminated homes continue absorbing light, as in the existing game rules.
    pub fn encloses(&self, color: u8) -> bool {
        let homes: Vec<usize> = self
            .homes
            .iter()
            .enumerate()
            .filter_map(|(c, h)| {
                if self.active(c as u8) {
                    h.map(|h| h.y * self.size + h.x)
                } else {
                    None
                }
            })
            .collect();
        if homes.len() < 2 {
            return false;
        }
        let mut seen = vec![false; self.cells() * 4];
        let mut queue = vec![homes[0] * 4];
        while let Some(id) = queue.pop() {
            if seen[id] {
                continue;
            }
            let cell = id / 4;
            let entry = id % 4;
            let diag = self.diagonals[cell];
            let own = diag > 0 && (diag - 1) / 2 == color;
            let connected = if own {
                let other = if (diag - 1) % 2 == 0 {
                    entry ^ 1
                } else {
                    3 - entry
                };
                (1 << entry) | (1 << other)
            } else {
                15
            };
            for d in 0..4 {
                if connected & (1 << d) != 0 {
                    seen[cell * 4 + d] = true;
                }
            }
            for d in 0..4 {
                if connected & (1 << d) == 0 || self.value(self.edge(cell, d)) == color + 1 {
                    continue;
                }
                if let Some(next) = self.neighbor(cell, d) {
                    let nid = next * 4 + (d ^ 2);
                    if !seen[nid] {
                        queue.push(nid);
                    }
                }
            }
        }
        homes.iter().any(|&c| !seen[c * 4])
    }
}
