use super::*;
fn empty(size: usize) -> Board {
    Request {
        version: 1,
        phase: "play".into(),
        size,
        players: vec![0, 1],
        current: 0,
        alive_mask: 3,
        homes: [
            Some(Home { x: 0, y: 0, dir: 0 }),
            Some(Home {
                x: size - 1,
                y: size - 1,
                dir: 2,
            }),
            None,
            None,
        ],
        horizontal: vec![0; size * (size + 1)],
        vertical: vec![0; size * (size + 1)],
        diagonals: vec![0; size * size],
        budget_ms: 100.0,
        max_depth: None,
        min_depth: None,
        max_nodes: None,
    }
    .into_board()
    .unwrap()
}
#[test]
fn placement_and_undo_restore_hash_and_optics() {
    let mut b = empty(8);
    let key = b.position_key();
    let hits = optics::trace(&b, 0, false).hits;
    let m = Move::Diag(7, 0);
    b.put(m, 0);
    assert_ne!(b.position_key(), key);
    b.remove(m);
    assert_eq!(b.position_key(), key);
    assert_eq!(optics::trace(&b, 0, false).hits, hits);
}
#[test]
fn enemy_mirrors_block_and_own_mirrors_split() {
    let mut b = empty(8);
    b.put(Move::Diag(7, 1), 0);
    assert_eq!(optics::trace(&b, 0, false).hits, 2);
    let m = b.edge(7, 1);
    b.put(m, 1);
    assert_eq!(optics::trace(&b, 0, false).hits, 0);
}
#[test]
fn dead_homes_still_absorb_but_do_not_constrain_enclosure() {
    let mut b = empty(8);
    b.players.push(2);
    b.homes[2] = Some(Home { x: 0, y: 7, dir: 3 });
    b.home_at[56] = 3;
    b.homes[1] = Some(Home { x: 0, y: 3, dir: 0 });
    b.home_at[63] = 0;
    b.home_at[24] = 2;
    b.alive = 5;
    let beam = optics::trace(&b, 0, false);
    assert_eq!(beam.hits & 2, 2);
    assert_eq!(beam.hits & 4, 0);
    for d in 0..4 {
        let m = b.edge(24, d);
        if b.available(m) {
            b.put(m, 0);
        }
    }
    assert!(!b.encloses(0));
    b.alive = 7;
    assert!(b.encloses(0));
}
#[test]
fn start_of_next_turn_settles_opponent_before_their_move() {
    let mut b = empty(8);
    b.put(Move::Diag(7, 0), 1);
    optics::settle_next(&mut b);
    assert_eq!(b.current, 1);
    assert!(!b.active(0));
}
#[test]
fn interrupted_search_restores_every_speculative_move() {
    let mut b = empty(8);
    let before = (
        b.horizontal.clone(),
        b.vertical.clone(),
        b.diagonals.clone(),
        b.position_key(),
    );
    let mut s = Search::new(0, 100.0, 2);
    assert!(s.choose(&mut b, 6).is_some());
    assert_eq!(
        (
            b.horizontal.clone(),
            b.vertical.clone(),
            b.diagonals.clone(),
            b.position_key()
        ),
        before
    );
}
#[test]
fn request_rejects_bad_dimensions_and_duplicate_players() {
    let malformed=br#"{"version":1,"phase":"play","size":4,"players":[0,0],"current":0,"aliveMask":1,"homes":[null,null,null,null],"horizontal":[],"vertical":[],"diagonals":[],"budgetMs":1}"#;
    let response: serde_json::Value = serde_json::from_slice(&choose_json(malformed)).unwrap();
    assert!(response["action"].is_null());
    assert!(response["error"].is_string());
}

fn screenshot() -> Board {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/screenshot.json")).unwrap();
    serde_json::from_value::<Request>(fixture["request"].clone())
        .unwrap()
        .into_board()
        .unwrap()
}

#[test]
fn reconstructed_routes_are_legal_and_do_not_leave_speculative_mirrors() {
    let mut board = screenshot();
    let before = board.position_key();
    let beams = vec![
        (0, optics::trace(&board, 0, false)),
        (1, optics::trace(&board, 1, false)),
    ];
    let map = optics::connections(&board, 1, 1);
    assert_eq!(map.distance, optics::connection_distances(&board, 1, 1));
    let proposals = planning::proposals(&board, 1, &beams[1].1, &beams, &map);
    assert!(proposals
        .iter()
        .any(|p| p.actions.len() == 3 && planning::verify(&mut board, 1, p)));
    for plan in proposals.iter().take(30) {
        let before_cells = (
            board.horizontal.clone(),
            board.vertical.clone(),
            board.diagonals.clone(),
        );
        planning::verify(&mut board, 1, plan);
        assert_eq!(
            (
                board.horizontal.clone(),
                board.vertical.clone(),
                board.diagonals.clone()
            ),
            before_cells
        );
        assert_eq!(board.position_key(), before);
    }
    let conflicting = planning::Plan {
        actions: vec![Move::Diag(16, 0), Move::Diag(16, 1)],
        hops: 0,
        exposure: 0,
    };
    assert!(!planning::verify(&mut board, 1, &conflicting));
    assert_eq!(board.position_key(), before);
    assert_eq!(board.diagonals[16], 0);
}

#[test]
fn interrupted_resistance_is_not_a_win_proof_and_restores_the_board() {
    let mut board = screenshot();
    board.put(Move::Diag(8, 0), 0);
    let before = board.position_key();
    assert_eq!(optics::trace(&board, 0, false).hits, 2);
    let interrupted = planning::resistance(&mut board, 0, 1, 4, || false);
    assert!(!interrupted.complete);
    assert_eq!(interrupted.saves, 0);
    let limited = planning::resistance(&mut board, 0, 1, 2, || true);
    assert_eq!(limited.saves, 2);
    assert!(!limited.complete);
    let exact = planning::resistance(&mut board, 0, 1, usize::MAX, || true);
    assert!(exact.complete && exact.saves > 2);
    assert_eq!(board.position_key(), before);
}

#[test]
fn route_distances_and_fast_evaluation_distances_agree_with_reflection_loops() {
    let mut rng = 17u64;
    for size in [4, 7, 16] {
        let mut board = empty(size);
        for _ in 0..size * 3 {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
            let choices: Vec<_> = board.all_moves().collect();
            if choices.is_empty() {
                break;
            }
            board.put(
                choices[rng as usize % choices.len()],
                ((rng >> 32) % 2) as u8,
            );
        }
        for color in 0..2 {
            assert_eq!(
                optics::connections(&board, color, 1 << (1 - color)).distance,
                optics::connection_distances(&board, color, 1 << (1 - color))
            );
        }
    }
}
