use std::io::{self, BufRead};
fn main() {
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        if line.trim().is_empty() {
            continue;
        }
        println!(
            "{}",
            String::from_utf8(light_chess_ai::choose_json(line.as_bytes())).unwrap()
        );
    }
}
