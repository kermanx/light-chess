pub mod board;
pub mod optics;
pub mod planning;
mod search;

use board::{Board, Home, Move};
use search::Search;
use serde::{Deserialize, Serialize};

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C" {
    fn now_ms() -> f64;
}
#[cfg(not(target_arch = "wasm32"))]
fn now_ms() -> f64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_secs_f64()
        * 1000.0
}
// Keep the unsafe imported clock behind a safe wrapper for the search engine.
#[cfg(target_arch = "wasm32")]
mod clock {
    pub fn now() -> f64 {
        unsafe { super::now_ms() }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub version: u8,
    pub phase: String,
    pub size: usize,
    pub players: Vec<u8>,
    pub current: u8,
    pub alive_mask: u8,
    pub homes: [Option<Home>; 4],
    pub horizontal: Vec<u8>,
    pub vertical: Vec<u8>,
    pub diagonals: Vec<u8>,
    pub budget_ms: f64,
    pub max_depth: Option<u8>,
    pub min_depth: Option<u8>,
    pub max_nodes: Option<u64>,
}

impl Request {
    pub fn into_board(self) -> Result<Board, String> {
        if self.version != 1 {
            return Err("不支持的 AI 协议版本".into());
        }
        if self.phase != "setup" && self.phase != "play" {
            return Err("无效的游戏阶段".into());
        }
        let cells = self
            .size
            .checked_mul(self.size)
            .filter(|&n| n > 0 && n <= (u32::MAX as usize) / 4)
            .ok_or("棋盘尺寸超出可表示范围")?;
        let edges = self
            .size
            .checked_add(1)
            .and_then(|n| n.checked_mul(self.size))
            .ok_or("棋盘尺寸溢出")?;
        if self.horizontal.len() != edges
            || self.vertical.len() != edges
            || self.diagonals.len() != cells
        {
            return Err("棋盘数组长度不匹配".into());
        }
        let mut mask = 0u8;
        for &c in &self.players {
            if c > 3 || mask & (1 << c) != 0 {
                return Err("无效的座位列表".into());
            }
            mask |= 1 << c;
        }
        if self.players.len() < 2
            || self.players.len() > 4
            || self.current > 3
            || mask & (1 << self.current) == 0
            || self.alive_mask & !mask != 0
            || self.alive_mask & (1 << self.current) == 0
        {
            return Err("无效的当前玩家或存活状态".into());
        }
        if self
            .horizontal
            .iter()
            .chain(self.vertical.iter())
            .any(|&v| v > 4)
            || self.diagonals.iter().any(|&v| v > 8)
        {
            return Err("无效的镜子编码".into());
        }
        let mut home_at = vec![0; cells];
        for (c, home) in self.homes.iter().enumerate() {
            if let Some(h) = home {
                if h.x >= self.size || h.y >= self.size || h.dir > 3 || mask & (1 << c) == 0 {
                    return Err("无效的基地".into());
                }
                let cell = h.y * self.size + h.x;
                if home_at[cell] != 0 || self.diagonals[cell] != 0 {
                    return Err("基地格被重复占用".into());
                }
                home_at[cell] = c as u8 + 1;
            } else if self.phase == "play" && mask & (1 << c) != 0 {
                return Err("对局缺少基地".into());
            }
        }
        let mut board = Board {
            size: self.size,
            horizontal: self.horizontal,
            vertical: self.vertical,
            diagonals: self.diagonals,
            homes: self.homes,
            home_at,
            players: self.players,
            current: self.current,
            alive: self.alive_mask,
            hash: 0,
        };
        board.refresh_hash();
        Ok(board)
    }
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Action {
    Diag {
        x: usize,
        y: usize,
        ori: &'static str,
    },
    Edge {
        id: String,
    },
    Setup {
        home: Home,
    },
}
impl Action {
    fn from_move(m: Move, size: usize) -> Self {
        match m {
            Move::Diag(cell, ori) => Self::Diag {
                x: cell % size,
                y: cell / size,
                ori: if ori == 0 { "/" } else { "\\" },
            },
            Move::Horizontal(i) => Self::Edge {
                id: format!("h:{}:{}", i % size, i / size),
            },
            Move::Vertical(i) => Self::Edge {
                id: format!("v:{}:{}", i % (size + 1), i / (size + 1)),
            },
        }
    }
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub nodes: u64,
    pub depth: u8,
    pub selection_depth: u8,
    pub elapsed_ms: f64,
    pub score: i32,
    pub mode: String,
    pub safe: bool,
    pub defense_complete: bool,
    pub candidates: usize,
    pub plans: usize,
    pub stop_reason: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub iterations: Vec<SearchIteration>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partial_iteration: Option<SearchIteration>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchCandidate {
    pub action: Action,
    pub score: i32,
    pub selection_score: i32,
    pub selection_priority: u8,
    pub direct_attack: bool,
    pub ordering_score: i32,
    pub line: Vec<Action>,
}
#[derive(Serialize)]
pub struct SearchIteration {
    pub depth: u8,
    pub candidates: Vec<SearchCandidate>,
}
#[derive(Serialize)]
pub struct Response {
    pub action: Option<Action>,
    pub stats: Stats,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn setup(board: &mut Board, budget: f64) -> Response {
    let start = clock_now();
    let color = board.current;
    if board.homes[color as usize].is_some() {
        return Response {
            action: None,
            stats: Stats::default(),
            error: Some("该 AI 已有基地".into()),
        };
    }
    let mut choices = Vec::new();
    for cell in 0..board.cells() {
        let x = cell % board.size;
        let y = cell / board.size;
        if board
            .homes
            .iter()
            .flatten()
            .any(|h| h.x.abs_diff(x).max(h.y.abs_diff(y)) < 2)
        {
            continue;
        }
        for dir in 0..4 {
            if board.neighbor(cell, dir).is_none() {
                continue;
            }
            // Favor separated rows/columns and space around the exit. Exact setup
            // validation below remains authoritative, including first-seat hits.
            let separation = board
                .homes
                .iter()
                .flatten()
                .map(|h| h.x.abs_diff(x).min(h.y.abs_diff(y)))
                .min()
                .unwrap_or(board.size / 3);
            let margin = x.min(y).min(board.size - 1 - x).min(board.size - 1 - y);
            choices.push((separation * 8 + margin * 2, Home { x, y, dir }));
        }
    }
    choices.sort_by(|a, b| b.0.cmp(&a.0));
    let mut best: Option<(i32, Home)> = None;
    let mut checked = 0;
    for (_, home) in choices {
        if best.is_some() && (clock_now() - start >= budget || checked >= 96) {
            break;
        }
        checked += 1;
        let cell = home.y * board.size + home.x;
        board.homes[color as usize] = Some(home);
        board.home_at[cell] = color + 1;
        let mut saved = Vec::new();
        for d in 0..4 {
            if d == home.dir {
                continue;
            }
            let m = board.edge(cell, d);
            saved.push((m, board.value(m)));
            match m {
                Move::Horizontal(i) => board.horizontal[i] = color + 1,
                Move::Vertical(i) => board.vertical[i] = color + 1,
                _ => unreachable!(),
            }
        }
        let legal = optics::trace(board, board.players[0], false).hits == 0;
        if legal {
            let mut danger = 0;
            for &enemy in &board.players {
                if enemy != color
                    && board.homes[enemy as usize].is_some()
                    && optics::trace(board, enemy, false).hits & (1 << color) != 0
                {
                    danger += 1;
                }
            }
            let nearest = board
                .homes
                .iter()
                .enumerate()
                .filter(|(c, _)| *c != color as usize)
                .filter_map(|(_, h)| *h)
                .map(|h| h.x.abs_diff(home.x).min(h.y.abs_diff(home.y)))
                .min()
                .unwrap_or(board.size / 3);
            let score = nearest as i32 * 10 - danger * 10_000;
            if best.is_none_or(|(s, _)| score > s) {
                best = Some((score, home));
            }
        }
        for (m, v) in saved {
            match m {
                Move::Horizontal(i) => board.horizontal[i] = v,
                Move::Vertical(i) => board.vertical[i] = v,
                _ => unreachable!(),
            }
        }
        board.homes[color as usize] = None;
        board.home_at[cell] = 0;
    }
    Response {
        action: best.map(|(_, home)| Action::Setup { home }),
        stats: Stats {
            nodes: checked,
            elapsed_ms: clock_now() - start,
            mode: "setup".into(),
            score: best.map_or(0, |x| x.0),
            ..Stats::default()
        },
        error: if best.is_none() {
            Some("找不到合法的基地布置".into())
        } else {
            None
        },
    }
}

pub fn clock_now() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        clock::now()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        now_ms()
    }
}

pub fn choose(request: Request) -> Response {
    let phase = request.phase.clone();
    let budget = if request.budget_ms.is_finite() {
        request.budget_ms.clamp(1.0, 120_000.0)
    } else {
        10_000.0
    };
    let max_depth = request.max_depth.unwrap_or(12).clamp(1, 32);
    let min_depth = request.min_depth.unwrap_or(0).min(max_depth);
    let max_nodes = request.max_nodes.unwrap_or(250_000).max(1);
    let mut board = match request.into_board() {
        Ok(b) => b,
        Err(error) => {
            return Response {
                action: None,
                stats: Stats::default(),
                error: Some(error),
            }
        }
    };
    if phase == "setup" {
        return setup(&mut board, budget);
    }
    let mode = if board.alive.count_ones() > 2 {
        "multiplayer"
    } else if board.players.iter().any(|&c| {
        c != board.current
            && board.active(c)
            && optics::trace(&board, c, false).hits & (1 << board.current) != 0
    }) {
        "defense"
    } else {
        "attack"
    };
    let mut search = Search::new(board.current, budget, max_nodes);
    search.minimum_depth = min_depth;
    let action = search
        .choose(&mut board, max_depth)
        .map(|m| Action::from_move(m, board.size));
    let error = if action.is_none() {
        Some("未在预算内找到已验证安全的合法落子，请增加思考时间或检查棋盘".into())
    } else {
        None
    };
    Response {
        action,
        stats: search.stats(mode),
        error,
    }
}

pub fn choose_json(input: &[u8]) -> Vec<u8> {
    let response = match serde_json::from_slice::<Request>(input) {
        Ok(r) => choose(r),
        Err(e) => Response {
            action: None,
            stats: Stats::default(),
            error: Some(format!("AI 请求格式错误: {e}")),
        },
    };
    serde_json::to_vec(&response).unwrap()
}

#[cfg(target_arch = "wasm32")]
static mut OUTPUT_LEN: usize = 0;

/// Allocations use boxed slices so the caller only needs pointer + exact length;
/// deallocation never guesses Vec capacity. One Worker owns each WASM instance.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
}
#[cfg(target_arch = "wasm32")]
#[no_mangle]
/// # Safety
/// `ptr` must be an unfreed allocation returned by this instance, and `len`
/// must equal the original allocation length. The host must not access it again.
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));
    }
}
#[cfg(target_arch = "wasm32")]
#[no_mangle]
/// # Safety
/// `ptr..ptr+len` must be a live readable allocation in this instance. Calls
/// must be serialized; the caller owns and must free the returned allocation.
pub unsafe extern "C" fn choose_action(ptr: *const u8, len: usize) -> *mut u8 {
    let output = choose_json(std::slice::from_raw_parts(ptr, len)).into_boxed_slice();
    OUTPUT_LEN = output.len();
    Box::into_raw(output) as *mut u8
}
#[cfg(target_arch = "wasm32")]
#[no_mangle]
/// # Safety
/// Read after a completed `choose_action` call, with no concurrent engine calls.
pub unsafe extern "C" fn result_len() -> usize {
    OUTPUT_LEN
}

#[cfg(test)]
mod tests;
