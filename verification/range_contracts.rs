#[path = "../src/range.rs"]
mod range;

use range::{RequestRange, Span};

fn check(actual: Option<Span>, expected: Option<(u128, u128)>, size: u64) {
    let bounds = actual.as_ref().map(|span| {
        assert!(span.length() > 0);
        let start = u128::from(span.start());
        let end = start + u128::from(span.length());
        assert!(end <= u128::from(size));
        assert_eq!(u128::from(span.last()) + 1, end);
        (start, end)
    });
    assert_eq!(bounds, expected);
}

#[kani::proof]
fn closed_range_matches_the_inclusive_request() {
    let first: u64 = kani::any();
    let last: u64 = kani::any();
    let size: u64 = kani::any();
    let admitted = first <= last && first < size;
    kani::cover!(admitted);
    kani::cover!(!admitted);
    let expected = if admitted {
        Some((u128::from(first), (u128::from(last) + 1).min(u128::from(size))))
    } else {
        None
    };
    check(RequestRange::Closed { first, last }.resolve(size), expected, size);
}

#[kani::proof]
fn open_range_extends_to_the_end() {
    let first: u64 = kani::any();
    let size: u64 = kani::any();
    kani::cover!(first < size);
    kani::cover!(first >= size);
    let expected = (first < size).then(|| (u128::from(first), u128::from(size)));
    check(RequestRange::From { first }.resolve(size), expected, size);
}

#[kani::proof]
fn suffix_range_is_clamped_to_the_representation() {
    let length: u64 = kani::any();
    let size: u64 = kani::any();
    kani::cover!(length > size && size > 0);
    kani::cover!(length == 0 || size == 0);
    let expected = if length == 0 || size == 0 {
        None
    } else {
        let total = u128::from(size);
        Some((total - total.min(u128::from(length)), total))
    };
    check(RequestRange::Suffix { length }.resolve(size), expected, size);
}
