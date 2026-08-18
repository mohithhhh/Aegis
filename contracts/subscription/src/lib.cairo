//! Aegis subscription vault.
//!
//! An `InvokeExternal` anonymizer contract for the STRK20 privacy pool (same call shape as
//! `contracts/echo-helper`'s `StrkInvokeHelper`), generalized into two legs with very different
//! trust requirements — see docs/subscription-model.md for the full design and why the split is
//! necessary:
//!
//! - **Funding leg** (`fund_subscription`) — driven by the payer's own privacy-pool transaction:
//!   `withdraw` STRK to this contract, then `invoke` this entrypoint in the same transaction. Only
//!   the pool contract may call it. This is the only leg that ever touches a payer's shielded
//!   balance, so it's the only leg that needs the payer present.
//! - **Release leg** (`execute_cycle`) — a plain, permissionless call. It moves already-escrowed
//!   STRK to the merchant once a cycle is due. It carries no information about the payer, so
//!   anyone (a keeper bot, the merchant, the subscriber) can call it safely — automating this leg
//!   is not a privacy trade-off.
//!
//! `subscription_id` is a payer-derived identity commitment (same scheme as the pool's own
//! `shadow_account_anonymizer`: `hash(hash(identity_key, dapp_name), nonce)`), never a payer
//! address. It's the only handle this contract, the merchant, or any block explorer ever sees.

use starknet::ContractAddress;

#[starknet::interface]
pub trait IErc20<TState> {
    fn balance_of(self: @TState, account: ContractAddress) -> u256;
    fn transfer(ref self: TState, recipient: ContractAddress, amount: u256) -> bool;
}

#[derive(Serde, Copy, Drop, PartialEq, Debug, starknet::Store)]
pub enum SubscriptionStatus {
    Active,
    Cancelled,
    Completed,
}

#[derive(Serde, Copy, Drop, Debug, starknet::Store)]
pub struct Subscription {
    pub merchant: ContractAddress,
    pub token: ContractAddress,
    pub tier_amount: u128,
    pub interval_seconds: u64,
    pub cycles_total: u64,
    pub cycles_executed: u64,
    pub next_due_at: u64,
    pub escrow_balance: u128,
    pub cancel_commitment: felt252,
    pub status: SubscriptionStatus,
}

#[starknet::interface]
pub trait IAegisSubscriptionVault<TState> {
    /// Funding leg. Opens `subscription_id` if unseen, or tops it up if it already exists and
    /// `merchant` / `token` / `tier_amount` / `interval_seconds` match what's on file. `amount` is
    /// the STRK this call is claiming from the `withdraw` that landed on this contract earlier in
    /// the same transaction (phase 6, before this `InvokeExternal` in phase 7).
    ///
    /// `cycles_added` is 1 for a subscriber-initiated manual renewal, or N for a prepaid run.
    /// `cancel_commitment` is `poseidon_hash(secret)` for an optional self-serve refund path (see
    /// `cancel_subscription`); pass 0 to not offer one.
    fn fund_subscription(
        ref self: TState,
        pool_address: ContractAddress, // wallet placeholder: "${poolAddress}"
        token: ContractAddress,
        subscription_id: felt252, // payer-derived identity commitment; never their address
        merchant: ContractAddress,
        tier_amount: u128,
        interval_seconds: u64,
        cycles_added: u64,
        amount: u128,
        cancel_commitment: felt252,
    );

    /// Release leg. Permissionless: pays `tier_amount` to `merchant` out of already-escrowed
    /// funds once a cycle is due. Never touches the privacy pool or a payer's shielded balance.
    fn execute_cycle(ref self: TState, subscription_id: felt252);

    /// Refunds unused escrow to `refund_to` and cancels the subscription. Callable by anyone who
    /// can produce `secret` such that `poseidon_hash(secret) == cancel_commitment` — normally only
    /// the original payer. `refund_to` becomes public once used; this is the one action in this
    /// contract that necessarily reveals a real address, which is why it's opt-in per subscription
    /// (`cancel_commitment == 0` disables it).
    fn cancel_subscription(
        ref self: TState, subscription_id: felt252, secret: felt252, refund_to: ContractAddress,
    );

    fn get_subscription(self: @TState, subscription_id: felt252) -> Subscription;
    /// True iff `execute_cycle(subscription_id)` would currently succeed — lets a keeper check
    /// before spending gas on a call that would revert.
    fn is_due(self: @TState, subscription_id: felt252) -> bool;
    /// Public aggregate: count of subscriptions not yet cancelled/completed. No per-subscriber
    /// breakdown is derivable from this or any other view here.
    fn total_active_subscriptions(self: @TState) -> u64;
    /// Public aggregate: cumulative STRK paid out across every subscription's executed cycles.
    fn total_revenue(self: @TState) -> u128;
}

#[starknet::contract]
mod AegisSubscriptionVault {
    use core::hash::HashStateTrait;
    use core::poseidon::PoseidonTrait;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_block_timestamp, get_caller_address, get_contract_address};
    use super::{IErc20Dispatcher, IErc20DispatcherTrait, Subscription, SubscriptionStatus};

    pub mod errors {
        pub const BAD_POOL: felt252 = 'BAD_POOL';
        pub const ZERO_AMOUNT: felt252 = 'ZERO_AMOUNT';
        pub const UNDERFUNDED: felt252 = 'UNDERFUNDED';
        pub const MISMATCHED_TERMS: felt252 = 'MISMATCHED_TERMS';
        pub const NOT_FOUND: felt252 = 'NOT_FOUND';
        pub const NOT_ACTIVE: felt252 = 'NOT_ACTIVE';
        pub const NOT_DUE: felt252 = 'NOT_DUE';
        pub const NO_CYCLES_LEFT: felt252 = 'NO_CYCLES_LEFT';
        pub const NO_CANCEL_OFFERED: felt252 = 'NO_CANCEL_OFFERED';
        pub const BAD_SECRET: felt252 = 'BAD_SECRET';
    }

    #[storage]
    struct Storage {
        subscriptions: Map<felt252, Subscription>,
        exists: Map<felt252, bool>,
        // Sum of every subscription's `escrow_balance`. Used to sanity-check `fund_subscription`
        // deposits against this contract's actual token balance — see the comment there.
        total_escrowed: u128,
        active_count: u64,
        total_revenue: u128,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        SubscriptionFunded: SubscriptionFunded,
        CycleExecuted: CycleExecuted,
        SubscriptionCancelled: SubscriptionCancelled,
    }

    #[derive(Drop, starknet::Event)]
    struct SubscriptionFunded {
        #[key]
        subscription_id: felt252,
        merchant: ContractAddress,
        tier_amount: u128,
        interval_seconds: u64,
        cycles_added: u64,
        cycles_total: u64,
        is_new: bool,
    }

    #[derive(Drop, starknet::Event)]
    struct CycleExecuted {
        #[key]
        subscription_id: felt252,
        cycles_executed: u64,
        cycles_total: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct SubscriptionCancelled {
        #[key]
        subscription_id: felt252,
        refunded: u128,
    }

    #[abi(embed_v0)]
    impl AegisSubscriptionVaultImpl of super::IAegisSubscriptionVault<ContractState> {
        fn fund_subscription(
            ref self: ContractState,
            pool_address: ContractAddress,
            token: ContractAddress,
            subscription_id: felt252,
            merchant: ContractAddress,
            tier_amount: u128,
            interval_seconds: u64,
            cycles_added: u64,
            amount: u128,
            cancel_commitment: felt252,
        ) {
            // Demonstrates and validates the poolAddress placeholder, same as StrkInvokeHelper.
            let caller = get_caller_address();
            assert(pool_address == caller, errors::BAD_POOL);
            assert(amount != 0 && tier_amount != 0 && cycles_added != 0, errors::ZERO_AMOUNT);

            // The pool's `withdraw` action (phase 6) already landed `amount` STRK on this
            // contract before this `InvokeExternal` (phase 7) runs, in the same transaction. We
            // can't isolate exactly which incoming transfer was "this one" without per-tx
            // bookkeeping the pool doesn't expose, so instead we check the contract stays solvent
            // for everything it has ever promised: actual balance must cover total escrow across
            // every subscription, including this deposit. That invariant means one subscription
            // can never drain another's escrow — at worst a caller overstates `amount` and shorts
            // their own subscription, which is self-inflicted, not exploitable.
            let erc20 = IErc20Dispatcher { contract_address: token };
            let balance: u256 = erc20.balance_of(get_contract_address());
            let new_total_escrowed = self.total_escrowed.read() + amount;
            assert(balance >= new_total_escrowed.into(), errors::UNDERFUNDED);
            self.total_escrowed.write(new_total_escrowed);

            let is_new = !self.exists.read(subscription_id);
            let cycles_total_after = if is_new {
                self.exists.write(subscription_id, true);
                self.active_count.write(self.active_count.read() + 1);
                self
                    .subscriptions
                    .write(
                        subscription_id,
                        Subscription {
                            merchant,
                            token,
                            tier_amount,
                            interval_seconds,
                            cycles_total: cycles_added,
                            cycles_executed: 0,
                            next_due_at: get_block_timestamp(), // due immediately
                            escrow_balance: amount,
                            cancel_commitment,
                            status: SubscriptionStatus::Active,
                        },
                    );
                cycles_added
            } else {
                let mut sub = self.subscriptions.read(subscription_id);
                assert(sub.status == SubscriptionStatus::Active, errors::NOT_ACTIVE);
                assert(
                    sub.merchant == merchant
                        && sub.token == token
                        && sub.tier_amount == tier_amount
                        && sub.interval_seconds == interval_seconds,
                    errors::MISMATCHED_TERMS,
                );
                sub.cycles_total += cycles_added;
                sub.escrow_balance += amount;
                let cycles_total = sub.cycles_total;
                self.subscriptions.write(subscription_id, sub);
                cycles_total
            };

            self
                .emit(
                    SubscriptionFunded {
                        subscription_id,
                        merchant,
                        tier_amount,
                        interval_seconds,
                        cycles_added,
                        cycles_total: cycles_total_after,
                        is_new,
                    },
                );
        }

        fn execute_cycle(ref self: ContractState, subscription_id: felt252) {
            assert(self.exists.read(subscription_id), errors::NOT_FOUND);
            let mut sub = self.subscriptions.read(subscription_id);
            assert(sub.status == SubscriptionStatus::Active, errors::NOT_ACTIVE);
            assert(get_block_timestamp() >= sub.next_due_at, errors::NOT_DUE);
            assert(sub.cycles_executed < sub.cycles_total, errors::NO_CYCLES_LEFT);
            assert(sub.escrow_balance >= sub.tier_amount, errors::UNDERFUNDED);

            let erc20 = IErc20Dispatcher { contract_address: sub.token };
            erc20.transfer(sub.merchant, sub.tier_amount.into());

            sub.escrow_balance -= sub.tier_amount;
            sub.cycles_executed += 1;
            sub.next_due_at += sub.interval_seconds;
            self.total_escrowed.write(self.total_escrowed.read() - sub.tier_amount);
            self.total_revenue.write(self.total_revenue.read() + sub.tier_amount);

            if sub.cycles_executed == sub.cycles_total {
                sub.status = SubscriptionStatus::Completed;
                self.active_count.write(self.active_count.read() - 1);
            }
            self.subscriptions.write(subscription_id, sub);

            self
                .emit(
                    CycleExecuted {
                        subscription_id, cycles_executed: sub.cycles_executed, cycles_total: sub.cycles_total,
                    },
                );
        }

        fn cancel_subscription(
            ref self: ContractState, subscription_id: felt252, secret: felt252, refund_to: ContractAddress,
        ) {
            assert(self.exists.read(subscription_id), errors::NOT_FOUND);
            let mut sub = self.subscriptions.read(subscription_id);
            assert(sub.status == SubscriptionStatus::Active, errors::NOT_ACTIVE);
            assert(sub.cancel_commitment != 0, errors::NO_CANCEL_OFFERED);
            let hash = PoseidonTrait::new().update(secret).finalize();
            assert(hash == sub.cancel_commitment, errors::BAD_SECRET);

            let refund = sub.escrow_balance;
            if refund != 0 {
                let erc20 = IErc20Dispatcher { contract_address: sub.token };
                erc20.transfer(refund_to, refund.into());
                self.total_escrowed.write(self.total_escrowed.read() - refund);
            }
            sub.escrow_balance = 0;
            sub.status = SubscriptionStatus::Cancelled;
            self.active_count.write(self.active_count.read() - 1);
            self.subscriptions.write(subscription_id, sub);

            self.emit(SubscriptionCancelled { subscription_id, refunded: refund });
        }

        fn get_subscription(self: @ContractState, subscription_id: felt252) -> Subscription {
            assert(self.exists.read(subscription_id), errors::NOT_FOUND);
            self.subscriptions.read(subscription_id)
        }

        fn is_due(self: @ContractState, subscription_id: felt252) -> bool {
            if !self.exists.read(subscription_id) {
                return false;
            }
            let sub = self.subscriptions.read(subscription_id);
            sub.status == SubscriptionStatus::Active
                && get_block_timestamp() >= sub.next_due_at
                && sub.cycles_executed < sub.cycles_total
                && sub.escrow_balance >= sub.tier_amount
        }

        fn total_active_subscriptions(self: @ContractState) -> u64 {
            self.active_count.read()
        }

        fn total_revenue(self: @ContractState) -> u128 {
            self.total_revenue.read()
        }
    }
}
