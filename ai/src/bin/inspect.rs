use light_chess_ai::{optics, Request};
use std::io::{self, BufRead};
fn main() {
    for line in io::stdin().lock().lines() {
        let request: Request = serde_json::from_str(&line.unwrap()).unwrap();
        let board = request.into_board().unwrap();
        let hits: Vec<_> = (0..4)
            .map(|c| optics::trace(&board, c, false).hits)
            .collect();
        let encloses: Vec<_> = (0..4).map(|c| board.encloses(c)).collect();
        let costs: Vec<_> = (0..4)
            .map(|c| {
                (0..4)
                    .map(|t| {
                        optics::source_distance(
                            &board,
                            c,
                            &optics::connection_distances(&board, c, 1 << t),
                        )
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        println!(
            "{}",
            serde_json::json!({"hits":hits,"encloses":encloses,"costs":costs})
        );
    }
}
