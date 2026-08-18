//! Test-only helper contracts. Always compiled (so `tests.cairo` can `declare()` them by name),
//! but never embedded in the real deployment target.
pub mod mock_erc20;
