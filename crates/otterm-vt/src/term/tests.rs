use super::*;

fn term(cols: usize, rows: usize, input: &str) -> Terminal {
    let mut t = Terminal::new(cols, rows);
    t.advance(input.as_bytes());
    t
}

fn text(t: &Terminal) -> Vec<String> {
    t.screen_text()
}

fn cell(t: &Terminal, row: usize, col: usize) -> &Cell {
    &t.screen()[row].cells[col]
}

#[test]
fn prints_and_wraps() {
    let t = term(5, 3, "hello world");
    assert_eq!(text(&t), ["hello", " worl", "d"]);
    assert!(t.screen()[0].wrapped);
    assert_eq!((t.cursor().row, t.cursor().col), (2, 1));
}

#[test]
fn last_column_defers_wrap_until_next_char() {
    let t = term(5, 2, "abcde");
    assert_eq!((t.cursor().row, t.cursor().col), (0, 4));
    let t = term(5, 2, "abcde\r\nx");
    assert_eq!(text(&t), ["abcde", "x"]);
    assert!(!t.screen()[0].wrapped);
}

#[test]
fn newline_scrolls_into_scrollback() {
    let t = term(10, 2, "one\r\ntwo\r\nthree");
    assert_eq!(text(&t), ["two", "three"]);
    assert_eq!(t.scrollback().len(), 1);
    assert_eq!(t.scrollback()[0].text(), "one");
}

#[test]
fn scrollback_is_limited() {
    let mut t = Terminal::new(10, 2);
    t.set_scrollback_limit(3);
    for i in 0..10 {
        t.advance(format!("{i}\r\n").as_bytes());
    }
    assert_eq!(t.scrollback().len(), 3);
    assert_eq!(t.scrollback()[0].text(), "6");
}

#[test]
fn cursor_movement_and_erase() {
    let t = term(10, 3, "abcdefghij\x1b[1;4H\x1b[K");
    assert_eq!(text(&t)[0], "abc");
    let t = term(10, 3, "abcdefghij\x1b[1;4H\x1b[1K");
    assert_eq!(text(&t)[0], "    efghij");
    let t = term(10, 3, "aaa\r\nbbb\r\nccc\x1b[2;2H\x1b[J");
    assert_eq!(text(&t), ["aaa", "b", ""]);
    let t = term(10, 3, "aaa\r\nbbb\r\nccc\x1b[2J");
    assert_eq!(text(&t), ["", "", ""]);
}

#[test]
fn erase_keeps_background_of_pen() {
    let t = term(4, 1, "\x1b[44m\x1b[2K");
    assert_eq!(cell(&t, 0, 0).attrs.bg, Color::Indexed(4));
}

#[test]
fn sgr_colors_and_flags() {
    let t = term(20, 1, "\x1b[1;3;31mA\x1b[38;5;200mB\x1b[38;2;1;2;3mC\x1b[48:2::4:5:6mD\x1b[0mE");
    assert_eq!(cell(&t, 0, 0).attrs.fg, Color::Indexed(1));
    assert!(cell(&t, 0, 0).attrs.has(flags::BOLD | flags::ITALIC));
    assert_eq!(cell(&t, 0, 1).attrs.fg, Color::Indexed(200));
    assert_eq!(cell(&t, 0, 2).attrs.fg, Color::Rgb(1, 2, 3));
    assert_eq!(cell(&t, 0, 3).attrs.bg, Color::Rgb(4, 5, 6));
    assert_eq!(cell(&t, 0, 4).attrs, Attrs::default());
}

#[test]
fn bright_colors_and_underline_styles() {
    let t = term(10, 1, "\x1b[91;104mA\x1b[4:3mB\x1b[24mC");
    assert_eq!(cell(&t, 0, 0).attrs.fg, Color::Indexed(9));
    assert_eq!(cell(&t, 0, 0).attrs.bg, Color::Indexed(12));
    assert!(cell(&t, 0, 1).attrs.has(flags::CURLY_UNDERLINE));
    assert!(!cell(&t, 0, 2).attrs.has(flags::ANY_UNDERLINE));
}

#[test]
fn wide_characters_take_two_cells() {
    let t = term(6, 2, "日本語");
    assert_eq!(text(&t), ["日本語", ""]);
    assert!(cell(&t, 0, 0).is_wide());
    assert!(cell(&t, 0, 1).is_spacer());
    assert_eq!(t.cursor().col, 5);
}

#[test]
fn wide_character_at_line_end_wraps() {
    let t = term(5, 2, "abcd日");
    assert_eq!(text(&t), ["abcd", "日"]);
    assert!(t.screen()[0].wrapped);
}

#[test]
fn overwriting_half_a_wide_character_clears_it() {
    let t = term(6, 1, "日本\x1b[1;2Hx");
    assert_eq!(text(&t), [" x本"]);
    assert!(!cell(&t, 0, 0).is_wide());
}

#[test]
fn ambiguous_width_setting() {
    let mut t = Terminal::new(6, 1);
    t.advance("○".as_bytes());
    assert_eq!(t.cursor().col, 1);
    let mut t = Terminal::new(6, 1);
    t.set_ambiguous_wide(true);
    t.advance("○".as_bytes());
    assert_eq!(t.cursor().col, 2);
}

#[test]
fn combining_marks_join_previous_cell() {
    let t = term(5, 1, "e\u{301}x");
    assert_eq!(t.screen()[0].cell_text(0), "e\u{301}");
    assert_eq!(cell(&t, 0, 1).ch, 'x');
}

#[test]
fn alt_screen_is_separate_and_restores_cursor() {
    // Like xterm, switching keeps the cursor where it was; the alt screen starts blank.
    let t = term(10, 3, "main\x1b[?1049hALT\x1b[2;2H");
    assert_eq!(text(&t)[0], "    ALT");
    assert!(t.modes().alt_screen);
    let mut t = t;
    t.advance(b"\x1b[?1049l");
    assert_eq!(text(&t)[0], "main");
    assert_eq!((t.cursor().row, t.cursor().col), (0, 4));
}

#[test]
fn alt_screen_never_writes_scrollback() {
    let t = term(10, 2, "\x1b[?1049h1\r\n2\r\n3\r\n4");
    assert!(t.scrollback().is_empty());
}

#[test]
fn scroll_region() {
    let t = term(5, 4, "1\r\n2\r\n3\r\n4\x1b[2;3r\x1b[3;1H\nx");
    assert_eq!(text(&t), ["1", "3", "x", "4"]);
    assert!(t.scrollback().is_empty(), "region not at top: nothing to scrollback");
}

#[test]
fn insert_and_delete_lines() {
    let t = term(5, 4, "1\r\n2\r\n3\r\n4\x1b[2;1H\x1b[L");
    assert_eq!(text(&t), ["1", "", "2", "3"]);
    let t = term(5, 4, "1\r\n2\r\n3\r\n4\x1b[2;1H\x1b[M");
    assert_eq!(text(&t), ["1", "3", "4", ""]);
    assert!(t.scrollback().is_empty(), "deleted lines are not history");
}

#[test]
fn delete_lines_on_primary_keeps_alt_screen_intact() {
    let mut t = term(5, 3, "\x1b[?1047hALT\x1b[?1047l1\r\n2\x1b[1;1H\x1b[M");
    assert_eq!(text(&t)[0], "2");
    t.advance(b"\x1b[?47h");
    assert_eq!(text(&t)[0], "", "47 without clear would show old alt content; 1047 cleared it");
}

#[test]
fn insert_and_delete_chars() {
    let t = term(6, 1, "abcdef\x1b[1;2H\x1b[2@");
    assert_eq!(text(&t), ["a  bcd"]);
    let t = term(6, 1, "abcdef\x1b[1;2H\x1b[2P");
    assert_eq!(text(&t), ["adef"]);
    let t = term(6, 1, "abcdef\x1b[1;2H\x1b[2X");
    assert_eq!(text(&t), ["a  def"]);
}

#[test]
fn tabs() {
    let t = term(20, 1, "a\tb");
    assert_eq!(cell(&t, 0, 8).ch, 'b');
    let t = term(20, 1, "\x1b[3g\x1b[1;5H\x1bH\r\tx");
    assert_eq!(cell(&t, 0, 4).ch, 'x');
}

#[test]
fn device_status_and_attributes_are_answered() {
    let mut t = term(10, 5, "\x1b[3;4H\x1b[6n\x1b[5n\x1b[c");
    assert_eq!(t.take_responses(), b"\x1b[3;4R\x1b[0n\x1b[?62;22c");
    assert!(t.take_responses().is_empty());
}

#[test]
fn modes_for_input_and_rendering() {
    let t = term(5, 1, "\x1b[?1h\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[?25l\x1b[5 q");
    let m = t.modes();
    assert!(m.app_cursor && m.bracketed_paste && m.mouse_sgr && !m.cursor_visible);
    assert_eq!(m.mouse, MouseMode::Drag);
    assert_eq!(m.cursor_shape, CursorShape::Bar);
}

#[test]
fn title_and_cwd_events() {
    let mut t = term(5, 1, "\x1b]0;a;b\x07\x1b]7;file://host/tmp\x1b\\");
    assert_eq!(t.title(), "a;b");
    assert_eq!(t.take_events(), [Event::Title("a;b".into()), Event::Cwd("file://host/tmp".into())]);
}

#[test]
fn dec_line_drawing() {
    let t = term(5, 1, "\x1b(0lqk\x1b(Bq");
    assert_eq!(text(&t), ["┌─┐q"]);
}

#[test]
fn damage_tracks_changed_rows() {
    let mut t = Terminal::new(5, 4);
    assert!(t.take_damage().full);
    t.advance(b"\x1b[3;1Hx");
    assert_eq!(t.take_damage(), Damage { full: false, rows: vec![2] });
    assert_eq!(t.take_damage(), Damage::default());
}

#[test]
fn resize_keeps_cursor_line_visible() {
    let mut t = term(5, 4, "1\r\n2\r\n3\r\n4");
    t.resize(5, 2);
    assert_eq!(text(&t), ["3", "4"]);
    assert_eq!(t.scrollback().len(), 2);
    assert_eq!(t.cursor().row, 1);
    t.resize(5, 4);
    assert_eq!(text(&t), ["1", "2", "3", "4"], "growing pulls lines back from scrollback");
    assert_eq!(t.cursor().row, 3);
}

#[test]
fn resize_columns_rewraps_and_pads() {
    let mut t = term(6, 1, "abc日");
    t.resize(4, 1);
    // 日 no longer fits after "abc": it wraps, and "abc" scrolls into history.
    assert_eq!(text(&t), ["日"]);
    assert_eq!(t.scrollback()[0].text(), "abc");
    t.resize(8, 1);
    assert_eq!(text(&t), ["abc日"]);
    assert_eq!(t.screen()[0].cells.len(), 8);
}

#[test]
fn reverse_index_scrolls_down_at_top() {
    let t = term(5, 3, "1\r\n2\r\n3\x1b[1;1H\x1bMx");
    assert_eq!(text(&t), ["x", "1", "2"]);
}

#[test]
fn origin_mode_positions_relative_to_region() {
    let t = term(5, 5, "\x1b[2;4r\x1b[?6h\x1b[1;1Hx");
    assert_eq!(text(&t)[1], "x");
}

#[test]
fn repeat_last_character() {
    let t = term(10, 1, "-\x1b[4b");
    assert_eq!(text(&t), ["-----"]);
}

#[test]
fn full_reset() {
    let mut t = term(5, 2, "\x1b[31mabc\x1b[?1h");
    t.advance(b"\x1bc");
    assert_eq!(text(&t), ["", ""]);
    assert!(!t.modes().app_cursor);
}

#[test]
fn split_utf8_and_escape_sequences_across_reads() {
    let mut t = Terminal::new(10, 1);
    let bytes = "\x1b[31m日本".as_bytes();
    for b in bytes {
        t.advance(std::slice::from_ref(b));
    }
    assert_eq!(text(&t), ["日本"]);
    assert_eq!(cell(&t, 0, 0).attrs.fg, Color::Indexed(1));
}

#[test]
fn combining_marks_follow_inserted_and_deleted_cells() {
    let mut t = term(6, 1, "ae\u{301}b");
    t.advance(b"\x1b[1;1H\x1b[2@");
    assert_eq!(text(&t), ["  ae\u{301}b"]);
    t.advance(b"\x1b[1;1H\x1b[3P");
    assert_eq!(text(&t), ["e\u{301}b"]);
    t.advance(b"\x1b[1;1Hx");
    assert_eq!(text(&t), ["xb"], "overwriting a cell drops its combining marks");
}

/// `Row::used` must cover every non-default cell, or clearing would leave garbage behind.
#[test]
fn rows_are_fully_cleared_after_scrolling_any_content() {
    let inputs = [
        "abc\x1b[5Xdef\r\n",
        "\x1b[44m\x1b[K\x1b[0m\r\n",
        "\x1b[44m\x1b[3P\x1b[0mx\r\n",
        "xy\x1b[1G\x1b[4@\r\n",
        "日本\u{301}\r\n",
        "\x1b#8\r\n",
    ];
    for input in inputs {
        let mut t = Terminal::new(8, 2);
        for _ in 0..4 {
            t.advance(input.as_bytes());
        }
        t.advance(b"\x1b[0m\r\n\r\n");
        assert_eq!(t.screen()[1].cells, Row::new(8, &Attrs::default()).cells, "input {input:?}");
        assert!(t.screen()[1].extra.is_empty());
    }
}

#[test]
fn osc8_links_mark_their_cells_and_survive_sgr_reset() {
    let mut t = Terminal::new(20, 2);
    t.advance(b"a\x1b]8;id=x;https://e.com/a;b\x1b\\\x1b[1mlink\x1b[0mz\x1b]8;;\x1b\\ end");
    let row = &t.screen()[0];
    let id = row.cells[1].attrs.link;
    assert_ne!(id, 0);
    assert_eq!(t.link(id), Some("https://e.com/a;b"), "a ';' in the URI is kept");
    assert_eq!(row.cells[5].attrs.link, id, "SGR 0 does not end the link");
    assert_eq!(row.cells[0].attrs.link, 0);
    assert_eq!(row.cells[7].attrs.link, 0, "OSC 8 with an empty URI ends it");
    // The same target again reuses the id.
    t.advance(b"\r\n\x1b]8;;https://e.com/a;b\x1b\\q\x1b]8;;\x1b\\");
    assert_eq!(t.screen()[1].cells[0].attrs.link, id);
}

#[test]
fn reset_modes_recovers_from_a_crashed_program_and_keeps_text() {
    let mut t = Terminal::new(10, 3);
    t.advance(b"keep\r\n\x1b[?1049h\x1b[?1000h\x1b[?2004h\x1b[?25l\x1b[>1u\x1b[2;3r\x1b[31m");
    t.reset_modes();
    let m = t.modes();
    assert!(!m.alt_screen && m.cursor_visible && !m.bracketed_paste);
    assert_eq!((m.mouse, m.kitty_keyboard), (MouseMode::Off, 0));
    assert_eq!(t.screen_text()[0], "keep");
}

#[test]
fn programs_can_ask_for_colors_modes_and_version() {
    let mut t = Terminal::new(10, 2);
    t.set_default_colors((0x2b, 0x2f, 0x36), (0xfa, 0xfa, 0xfa), (0x3a, 0x6e, 0xa5));
    t.advance(b"\x1b]11;?\x07");
    assert_eq!(t.take_responses(), b"\x1b]11;rgb:fafa/fafa/fafa\x1b\\");
    t.advance(b"\x1b]10;?\x1b\\");
    assert_eq!(t.take_responses(), b"\x1b]10;rgb:2b2b/2f2f/3636\x1b\\");
    t.advance(b"\x1b[?2004h\x1b[?2004$p\x1b[?2026$p\x1b[?9999$p");
    assert_eq!(t.take_responses(), b"\x1b[?2004;1$y\x1b[?2026;2$y\x1b[?9999;0$y");
    t.advance(b"\x1b[>q");
    assert!(t.take_responses().starts_with(b"\x1bP>|otterm "));
}

#[test]
fn decscusr_zero_restores_the_configured_cursor() {
    let mut t = Terminal::new(10, 2);
    t.set_default_cursor(CursorShape::Bar, false);
    assert_eq!(t.modes().cursor_shape, CursorShape::Bar);
    t.advance(b"\x1b[2 q");
    assert_eq!((t.modes().cursor_shape, t.modes().cursor_blink), (CursorShape::Block, false));
    t.advance(b"\x1b[0 q");
    assert_eq!((t.modes().cursor_shape, t.modes().cursor_blink), (CursorShape::Bar, false));
    t.advance(b"\x1b[2 q\x1bc");
    assert_eq!(t.modes().cursor_shape, CursorShape::Bar, "RIS keeps the configured style");
}

#[test]
fn lines_keep_their_number_when_they_scroll_into_history() {
    let mut t = Terminal::new(10, 2);
    t.set_scrollback_limit(2);
    t.advance(b"l0\r\nl1\r\nl2\r\nl3\r\nl4");
    // l0 was dropped from the 2-line scrollback.
    assert_eq!(t.history_base(), 1);
    assert_eq!(t.screen_top(), 3);
    assert_eq!(t.line(1).unwrap().text(), "l1");
    assert_eq!(t.line(4).unwrap().text(), "l4");
    assert!(t.line(0).is_none());
    assert!(t.line(5).is_none());
}

#[test]
fn text_range_joins_wrapped_lines_and_trims_blanks() {
    let mut t = Terminal::new(8, 4);
    t.advance("abcdefghij\r\n日本 x  \r\nlast".as_bytes());
    // Row 0 "abcdefgh" wraps into row 1 "ij".
    assert_eq!(t.text_range((0, 0), (3, 1)), "abcdefghij\n日本 x\nla");
    // Order does not matter; a range inside one line.
    assert_eq!(t.text_range((2, 3), (2, 0)), "日本");
    // Starting on a wide character's spacer copies what follows; trailing blanks are dropped.
    assert_eq!(t.text_range((2, 1), (2, 4)), "本");
}
