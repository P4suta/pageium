use std::num::NonZeroU64;

pub(crate) enum RequestRange {
    Closed { first: u64, last: u64 },
    From { first: u64 },
    Suffix { length: u64 },
}

pub(crate) struct Span {
    start: u64,
    length: NonZeroU64,
}

impl Span {
    pub(crate) const fn start(&self) -> u64 {
        self.start
    }

    pub(crate) const fn length(&self) -> u64 {
        self.length.get()
    }

    pub(crate) const fn last(&self) -> u64 {
        self.start + self.length.get() - 1
    }
}

impl RequestRange {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value.split_once('-')? {
            ("", last) => Some(Self::Suffix {
                length: decimal(last)?,
            }),
            (first, "") => Some(Self::From {
                first: decimal(first)?,
            }),
            (first, last) => Some(Self::Closed {
                first: decimal(first)?,
                last: decimal(last)?,
            }),
        }
    }

    pub(crate) fn resolve(self, size: u64) -> Option<Span> {
        let (start, end) = match self {
            Self::Closed { first, last } => (first, last.saturating_add(1).min(size)),
            Self::From { first } => (first, size),
            Self::Suffix { length } => (size.saturating_sub(length), size),
        };
        Some(Span {
            start,
            length: NonZeroU64::new(end.checked_sub(start)?)?,
        })
    }
}

fn decimal(input: &str) -> Option<u64> {
    if input.is_empty() || !input.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(input.parse().unwrap_or(u64::MAX))
}
