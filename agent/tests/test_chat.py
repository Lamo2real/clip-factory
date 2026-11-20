"""Chat hype maths (docs/CONTRACTS.md §37.5): rate, baseline, spikes, lag, spam, mood and the flags."""

from __future__ import annotations

import json
import random

import pytest

from clipfactory_agent import chat
from clipfactory_agent.chat import (
    CHAT_NOTE,
    ChatSignal,
    ChatSpike,
    Collector,
    Message,
    RawChat,
    analyze,
    baseline,
    calibrate_lag,
    clean_text,
    find_peaks,
    flag_of,
    mood_of,
    per_second,
    rolling_sum,
    spam_of,
)


def test_per_second_counts_and_leaves_uncovered_seconds_out() -> None:
    counts = per_second([0.2, 0.9, 1.5, 4.0, 9.5], 6, [[0, 3]])
    assert counts == [2.0, 1.0, 0.0, None, None, None]


def test_the_five_second_sum_is_centred() -> None:
    r = rolling_sum([0.0, 0.0, 5.0, 0.0, 0.0, 0.0, 0.0])
    assert r == [5.0, 5.0, 5.0, 5.0, 5.0, 0.0, 0.0]
    assert rolling_sum([1.0, None, 1.0])[1] is None


def test_a_flat_chat_has_no_spikes() -> None:
    assert find_peaks([10.0] * 900) == []
    rng = random.Random(1)  # noqa: S311 (test data)
    assert find_peaks([float(rng.randint(8, 12)) for _ in range(900)]) == []


def test_a_small_chat_going_from_nothing_to_three_is_no_spike() -> None:
    rate: list[float | None] = [0.0] * 600
    for t in range(300, 305):
        rate[t] = 3.0
    assert find_peaks(rate) == []  # under MIN_RATE, and sqrt(median)/1 keeps z honest


def test_one_burst_is_one_spike_with_its_onset_z_and_lift() -> None:
    counts: list[float | None] = [2.0] * 900
    for t in range(400, 415):
        counts[t] = 12.0
    peaks = find_peaks(rolling_sum(counts))
    assert len(peaks) == 1
    p = peaks[0]
    assert 397 <= p.onset <= 400 and 400 <= p.peak <= 414
    assert p.z >= 3 and p.lift >= 1.8


def test_bursts_within_twenty_seconds_merge_and_far_ones_do_not() -> None:
    counts: list[float | None] = [2.0] * 900
    for start in (300, 315, 600):
        for t in range(start, start + 4):
            counts[t] = 15.0
    peaks = find_peaks(rolling_sum(counts))
    assert len(peaks) == 2 and peaks[0].onset < 320 and peaks[1].onset > 590


def test_uncovered_seconds_stay_out_of_the_baseline() -> None:
    rate: list[float | None] = [None] * 300 + [4.0] * 300
    med, sd = baseline(rate)
    assert med[450] == pytest.approx(4.0) and sd[450] >= 2.0


def test_at_most_sixty_spikes_are_kept() -> None:
    raw = RawChat("twitch", [[0, 12_000]])
    rng = random.Random(4)  # noqa: S311 (test data)
    t = 0.0
    while t < 12_000:
        raw.collector.add(t, f"u{rng.randint(0, 50)}", "hi")
        t += 1.0
    for k in range(80):
        base = 100 + k * 140
        for j in range(40):
            raw.collector.add(base + j * 0.1, f"x{j}", f"word{j % 9}")
    sig = analyze(raw, 12_000, [])
    assert sig is not None and len(sig.spikes) == chat.MAX_SPIKES
    assert [s.onset for s in sig.spikes] == sorted(s.onset for s in sig.spikes)


# --- lag ---------------------------------------------------------------------------------------------------------


def test_the_lag_is_learned_from_loud_spikes() -> None:
    loud = [100.0, 300.0, 500.0, 700.0, 900.0]
    onsets = [t + 6 for t in loud]
    assert calibrate_lag(onsets, loud) == 6


def test_fewer_than_four_matches_keeps_five_seconds() -> None:
    assert calibrate_lag([106.0, 306.0, 506.0], [100.0, 300.0, 500.0]) == 5
    assert calibrate_lag([], [1.0]) == 5 and calibrate_lag([10.0], []) == 5


def test_the_lag_stays_between_two_and_ten() -> None:
    loud = [100.0, 300.0, 500.0, 700.0, 900.0]
    assert calibrate_lag([t + 30 for t in loud], loud) == 5  # nothing in range matches
    assert calibrate_lag([t + 1 for t in loud], loud) in range(2, 11)


def busy_raw(*, burst_at: float = 500.0, text: str = "KEKW", users: int = 20, seconds: int = 1200) -> RawChat:
    raw = RawChat("twitch", [[0, seconds]])
    rng = random.Random(2)  # noqa: S311 (test data)
    for s in range(seconds):
        for _ in range(2):
            raw.collector.add(s + rng.random(), f"regular{rng.randint(0, 40)}", f"chatting {rng.randint(0, 999)}")
    for j in range(60):
        raw.collector.add(burst_at + j * 0.1, f"regular{j % users}", text)
    return raw


def test_t_and_window_follow_the_lag() -> None:
    sig = analyze(busy_raw(), 1200, [])
    assert sig is not None and len(sig.spikes) == 1
    s = sig.spikes[0]
    assert sig.lag == 5 and s.t == s.onset - 5
    assert s.window == (s.onset - 10, s.onset - 2)


# --- spam, mood and flags ----------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "clean"),
    [
        ("LMAOOOO", "lmao"),
        ("W W W", "w"),
        ("WWWW", "w"),
        ("?????", "?"),
        ("KEKW KEKW", "kekw"),
        ("💀💀", "💀"),
        ("@someone lol", "lol"),
        ("look https://example.com/x now", "lok now"),
        ("   ", ""),
    ],
)
def test_messages_are_cleaned_before_counting(raw: str, clean: str) -> None:
    assert clean_text(raw) == clean


def msgs(texts: list[str], users: list[str] | None = None) -> list[Message]:
    users = users or [f"u{i}" for i in range(len(texts))]
    return [Message(float(i), u, clean_text(t)) for i, (t, u) in enumerate(zip(texts, users, strict=True))]


def test_spam_needs_share_copies_and_people() -> None:
    assert spam_of(msgs(["KEKW"] * 6 + ["hi"] * 4)) == ("kekw", 0.6)
    assert spam_of(msgs(["KEKW"] * 4 + ["hi"] * 2))[0] is None  # too few copies
    assert spam_of(msgs(["KEKW"] * 5 + [f"x{i}" for i in range(20)]))[0] is None  # too small a share
    one = msgs(["KEKW"] * 10, ["same"] * 10)
    assert spam_of(one)[0] is None  # one person spamming is not the crowd
    assert flag_of(one, 0, {}, 0.0, 0.0) == "bots"


def test_moods() -> None:
    assert mood_of("kekw") == "laugh" and mood_of("💀") == "laugh" and mood_of(clean_text("LMAOOO")) == "laugh"
    assert mood_of("w") == "hype" and mood_of(clean_text("LETS GOOO")) == "hype"
    assert mood_of("?") == "shock" and mood_of("no way") == "shock"
    assert mood_of("clip it") == "clip" and mood_of("+clip") == "clip"
    assert mood_of("l") == "fail" and mood_of("rip") == "fail"
    assert mood_of("i like turtles") is None
    assert mood_of("what a shot l") == "shock"  # a lone "l" inside a sentence is not a fail


def test_commands_bots_and_notices_are_not_chat() -> None:
    c = Collector()
    assert not c.add(1, "fan", "!uptime")
    assert not c.add(1, "Nightbot", "Follow the socials")
    assert not c.add(1, "", "", system=True)
    assert not c.add(-1, "fan", "hi")
    assert c.add(2, "fan", "hello", msg_id="a") and not c.add(2, "fan", "hello", msg_id="a")  # a page seen twice
    assert len(c) == 1 and c.notices == [1.0] and c.dropped == 2
    assert all("fan" not in m.user for m in c.messages)  # names are hashed


def test_raid_giveaway_and_subs_flags() -> None:
    users = [f"u{i}" for i in range(20)]
    assert flag_of(msgs(["raid incoming"] * 10 + ["hi"] * 10, users), 0, {}, 900.0, 0.0) == "raid"
    long = "THE CREW HAS ARRIVED TO TAKE OVER THE STREAM HYPE HYPE"
    assert flag_of(msgs([long] * 12 + ["x"] * 8, users), 0, {}, 900.0, 0.0) == "raid"
    first_seen = {u: 1000.0 for u in users}  # everybody's first message is in this burst
    assert flag_of(msgs([f"hello {i}" for i in range(20)], users), 0, first_seen, 1000.0, 0.0) == "raid"
    assert flag_of(msgs([f"hello {i}" for i in range(20)], users), 0, first_seen, 100.0, 0.0) is None  # too early
    assert flag_of(msgs(["enter the giveaway"] * 8 + ["hi"] * 12, users), 0, {}, 0.0, 0.0) == "giveaway"
    assert flag_of(msgs(["hi"] * 20, users), 12, {}, 0.0, 0.0) == "subs"
    assert flag_of(msgs(["kekw"] * 20, users), 0, {}, 0.0, 0.0) is None


def test_a_flagged_spike_is_weak_and_never_a_reason() -> None:
    raw = busy_raw(text="raid raid raid")
    sig = analyze(raw, 1200, [])
    assert sig is not None and sig.spikes[0].flag == "raid"
    s = sig.spikes[0]
    assert not s.counts and s.strength <= 0.3 * (2.0 + 0.4 + 0.3)
    assert "maybe a raid" in sig.hint_line(0, 1200) and "moment ~" not in sig.hint_line(0, 1200)
    assert chat.summary(sig) == 0 and not sig.strong_in(0, 1200)


def test_a_real_burst_names_its_spam_and_mood() -> None:
    sig = analyze(busy_raw(), 1200, [])
    assert sig is not None
    s = sig.spikes[0]
    assert (s.spam, s.mood, s.flag) == ("kekw", "laugh", None)
    assert s.share >= 0.3 and s.strength >= 1.5 and sig.strong_in(0, 1200) and chat.summary(sig) == 1


# --- what the finder reads, and chat.json ------------------------------------------------------------------------


def spike(t: float, **kw: object) -> ChatSpike:
    base: dict[str, object] = {
        "t": t,
        "onset": t + 5,
        "peak": t + 8,
        "z": 9.0,
        "lift": 6.2,
        "strength": 2.4,
        "window": (t - 5, t + 3),
    }
    base.update(kw)
    return ChatSpike(**base)  # type: ignore[arg-type]


def test_the_hint_line() -> None:
    sig = ChatSignal(
        "twitch", 1.0, 100, 5, [], [spike(3717, spam="kekw", mood="laugh"), spike(6000, flag="raid", lift=3)]
    )
    line = sig.hint_line(0, 7200)
    assert line == (
        'Chat spikes: 1:02:02 (x6, chat laughing, spam "kekw", moment ~1:01:52–1:02:00), 1:40:05 (x3, maybe a raid)'
    )
    assert sig.hint_line(0, 100) == ""


def test_at_most_ten_chat_spikes_per_window() -> None:
    sig = ChatSignal("twitch", 1.0, 100, 5, [], [spike(100 + i * 60, strength=1 + i / 100) for i in range(14)])
    line = sig.hint_line(0, 1800)
    assert line.count("moment ~") == 10 and line.endswith("(+4 weaker ones)")


def test_chat_json_round_trip_and_version() -> None:
    sig = ChatSignal(
        "screen", 0.5, 42, 6, [1.0, None, 2.5], [spike(100, spam="w", mood="hype")], {"x": 1, "y": 2, "w": 3, "h": 4}
    )
    body = json.loads(json.dumps(sig.to_json()))
    assert body["version"] == 1 and body["lagSeconds"] == 6 and body["rate"] == [1.0, None, 2.5]
    back = ChatSignal.from_json(body)
    assert back == sig
    assert ChatSignal.from_json({**body, "version": 2}) is None
    assert ChatSignal.from_json({**body, "source": "irc"}) is None
    assert ChatSignal.from_json(None) is None


def test_spam_text_is_clean_and_short() -> None:
    raw = busy_raw(text='"MOST INSANE PLAY OF THE YEAR RIGHT THERE"')
    sig = analyze(raw, 1200, [])
    assert sig is not None
    spam = sig.spikes[0].spam
    assert spam is not None and len(spam) <= 24 and '"' not in spam
    assert ChatSpike.from_json({**sig.spikes[0].to_json(), "spam": "x" * 99}).spam == "x" * 24


def test_no_messages_or_no_coverage_is_no_signal() -> None:
    assert analyze(RawChat("twitch", [[0, 100]]), 100, []) is None
    raw = RawChat("twitch", [])
    raw.collector.add(1, "a", "hi")
    assert analyze(raw, 100, []) is None


def test_the_finder_note_names_the_lag_and_the_flags() -> None:
    for words in ("late", "moment ~", "never enough alone", "maybe a", "giveaway", "subs", "bots"):
        assert words in CHAT_NOTE


# --- review fixes: chance lag, gaps, words shown, kid-proof spam ---------------------------------------------------


def test_a_loud_stream_does_not_make_a_lag_out_of_chance() -> None:
    loud = [float(t) for t in range(0, 1000, 12)]  # a spike every 12 s: every lag matches by luck
    rng = random.Random(7)  # noqa: S311 (test data)
    onsets = sorted(rng.uniform(0, 1000) for _ in range(40))
    assert calibrate_lag(onsets, loud) == 5
    clear = [float(t) for t in range(100, 1000, 97)]  # spikes far apart: a real 7 s lag stands out
    assert calibrate_lag([t + 7 for t in clear], clear) == 7


def test_flagged_bursts_do_not_teach_the_lag() -> None:
    raw = busy_raw(text="raid raid raid", burst_at=500.0)
    sig = analyze(raw, 1200, [490.0, 590.0, 690.0, 790.0, 890.0])
    assert sig is not None and sig.lag == 5.0


def test_the_first_burst_after_a_gap_is_not_a_raid() -> None:
    # chat is covered 0-500 and 700-1200; the burst at 900 is by people who spoke in the gap, not new people
    raw = RawChat("twitch", [[0, 500], [700, 1200]])
    for s in range(1200):
        if 500 <= s < 700:
            continue
        for u in range(3):
            raw.collector.add(s + u * 0.2, f"reg{s % 30}_{u}", f"hello there {s}")
    for i in range(60):
        raw.collector.add(900 + i * 0.05, f"newcomer{i % 25}", "KEKW")
    sig = analyze(raw, 1200, [])
    assert sig is not None
    burst = [s for s in sig.spikes if 890 <= s.onset <= 905]
    assert burst and burst[0].flag is None


def test_game_words_do_not_make_raid_or_giveaway_flags() -> None:
    users = [f"u{i}" for i in range(20)]
    assert flag_of(msgs(["drop it"] * 8 + ["hi"] * 12, users), 0, {}, 0.0, 0.0) is None
    assert flag_of(msgs(["join us"] * 8 + ["hi"] * 12, users), 0, {}, 0.0, 0.0) is None
    assert flag_of(msgs(["raid boss"] * 3 + ["hi"] * 17, users), 0, {}, 0.0, 0.0) is None


def test_the_spam_word_is_shown_as_typed_not_mangled() -> None:
    c = Collector()
    for i in range(10):
        c.add(float(i), f"u{i}", "POGGERS" if i % 2 else "pogggers", msg_id=str(i))
    word, _ = spam_of(c.messages)
    assert word is not None and word.startswith("pogg") and word != "pogers"
    d = Collector()
    for i in range(8):
        d.add(float(i), f"u{i}", "good", msg_id=str(i))
    assert spam_of(d.messages)[0] == "good"


@pytest.mark.parametrize("bad", ["fuck", "sh1t", "f*ck", "FUUUCK", "kys", "asshole"])
def test_bad_words_are_never_a_spam_word(bad: str) -> None:
    assert chat.safe_spam(bad) is None and chat.profane(bad)
    c = Collector()
    for i in range(10):
        c.add(float(i), f"u{i}", bad, msg_id=str(i))
    assert spam_of(c.messages)[0] is None


def test_clean_words_pass_the_filter() -> None:
    for ok_word in ("kekw", "class", "assume", "pass", "LETS GO", "💀", "?"):
        assert not chat.profane(ok_word) and chat.safe_spam(ok_word)
