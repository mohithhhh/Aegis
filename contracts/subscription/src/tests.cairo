use core::hash::HashStateTrait;
use core::poseidon::PoseidonTrait;
use starknet::ContractAddress;
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_timestamp,
    start_cheat_caller_address, stop_cheat_caller_address,
};
use super::test_utils_contracts::mock_erc20::{IMockErc20Dispatcher, IMockErc20DispatcherTrait};
use super::{
    IAegisSubscriptionVaultDispatcher, IAegisSubscriptionVaultDispatcherTrait, SubscriptionStatus,
};

const TIER_AMOUNT: u128 = 10;
const INTERVAL: u64 = 2_592_000; // 30 days
const SUB_ID: felt252 = 'sub-1';

fn pool() -> ContractAddress {
    'POOL'.try_into().unwrap()
}
fn merchant() -> ContractAddress {
    'MERCHANT'.try_into().unwrap()
}
fn stranger() -> ContractAddress {
    'STRANGER'.try_into().unwrap()
}

fn deploy_vault() -> IAegisSubscriptionVaultDispatcher {
    let contract = declare("AegisSubscriptionVault").unwrap().contract_class();
    let (address, _) = contract.deploy(@array![]).unwrap();
    IAegisSubscriptionVaultDispatcher { contract_address: address }
}

fn deploy_token() -> (IMockErc20Dispatcher, ContractAddress) {
    let contract = declare("MockErc20").unwrap().contract_class();
    let (address, _) = contract.deploy(@array![]).unwrap();
    (IMockErc20Dispatcher { contract_address: address }, address)
}

// Mints `amount` to the vault (standing in for the pool's `withdraw` action that would have
// landed it there in the same tx) and calls `fund_subscription` as the pool.
fn fund(
    vault: IAegisSubscriptionVaultDispatcher,
    token_disp: IMockErc20Dispatcher,
    token: ContractAddress,
    cycles_added: u64,
    amount: u128,
    cancel_commitment: felt252,
) {
    token_disp.mint(vault.contract_address, amount.into());
    start_cheat_caller_address(vault.contract_address, pool());
    vault
        .fund_subscription(
            pool(), token, SUB_ID, merchant(), TIER_AMOUNT, INTERVAL, cycles_added, amount,
            cancel_commitment,
        );
    stop_cheat_caller_address(vault.contract_address);
}

#[test]
fn fund_new_subscription_is_active_and_due_immediately() {
    let vault = deploy_vault();
    let (token_disp, token) = deploy_token();
    fund(vault, token_disp, token, 1, TIER_AMOUNT, 0);

    let sub = vault.get_subscription(SUB_ID);
    assert(sub.status == SubscriptionStatus::Active, 'active');
    assert(sub.merchant == merchant(), 'merchant');
    assert(sub.escrow_balance == TIER_AMOUNT, 'escrow');
    assert(sub.cycles_total == 1, 'cycles_total');
    assert(sub.cycles_executed == 0, 'cycles_executed');
    assert(vault.total_active_subscriptions() == 1, 'active count');
    assert(vault.is_due(SUB_ID), 'should be due');
}

#[test]
#[should_panic(expected: 'BAD_POOL')]
fn fund_rejects_non_pool_caller() {
    let vault = deploy_vault();
    let (token_disp, token) = deploy_token();
    token_disp.mint(vault.contract_address, TIER_AMOUNT.into());
    start_cheat_caller_address(vault.contract_address, stranger());
    vault.fund_subscription(pool(), token, SUB_ID, merchant(), TIER_AMOUNT, INTERVAL, 1, TIER_AMOUNT, 0);
}

#[test]
#[should_panic(expected: 'UNDERFUNDED')]
fn fund_rejects_claiming_more_than_was_actually_deposited() {
    let vault = deploy_vault();
    let (token_disp, token) = deploy_token();
    // Mint less than `amount` claims - the vault must catch this via the balance check.
    token_disp.mint(vault.contract_address, 1);
    start_cheat_caller_address(vault.contract_address, pool());
    vault
        .fund_subscription(
            pool(), token, SUB_ID, merchant(), TIER_AMOUNT, INTERVAL, 1, TIER_AMOUNT, 0,
        );
}

#[test]
fn fund_top_up_accumulates_cycles_and_escrow() {
    let vault = deploy_vault();
    let (token_disp, token) = deploy_token();
    fund(vault, token_disp, token, 1, TIER_AMOUNT, 0);
    fund(vault, token_disp, token, 1, TIER_AMOUNT, 0);

    let sub = vault.get_subscription(SUB_ID);
    assert(sub.cycles_total == 2, 'cycles_total after top-up');
    assert(sub.escrow_balance == 2 * TIER_AMOUNT, 'escrow after top-up');
    assert(vault.total_active_subscriptions() == 1, 'still one subscription');
}

#[test]
#[should_panic(expected: 'MISMATCHED_TERMS')]
fn fund_top_up_rejects_mismatched_tier_amount() {
    let vault = deploy_vault();
    let (token_disp, token) = deploy_token();
    fund(vault, token_disp, token, 1, TIER_AMOUNT, 0);

    token_disp.mint(vault.contract_address, (TIER_AMOUNT + 1).into());
    start_cheat_caller_address(vault.contract_address, pool());
    vault
        .fund_subscription(
            pool(), token, SUB_ID, merchant(), TIER_AMOUNT + 1, INTERVAL, 1, TIER_AMOUNT + 1, 0,
        );
}

#[test]
fn execute_cycle_pays_merchant_and_advances_schedule() {
    let vault = deploy_vault();
    let (token_disp, token) = deploy_token();
    fund(vault, token_disp, token, 2, 2 * TIER_AMOUNT, 0);

    vault.execute_cycle(SUB_ID);

    assert(token_disp.balance_of(merchant()) == TIER_AMOUNT.into(), 'merchant paid');
    let sub = vault.get_subscription(SUB_ID);
    assert(sub.cycles_executed == 1, 'one cycle executed');
    assert(sub.escrow_balance == TIER_AMOUNT, 'escrow drawn down');
    assert(sub.next_due_at == INTERVAL, 'next_due_at advanced'); // started at block time 0
    assert(sub.status == SubscriptionStatus::Active, 'still active, one cycle left');
    assert(vault.total_revenue() == TIER_AMOUNT, 'revenue aggregate');
}

#[test]
#[should_panic(expected: 'NOT_DUE')]
fn execute_cycle_reverts_before_next_due_at() {
    let vault = deploy_vault();
    let (token_disp, token) = deploy_token();
    fund(vault, token_disp, token, 2, 2 * TIER_AMOUNT, 0);
    vault.execute_cycle(SUB_ID); // consumes the first (immediately-due) cycle
    vault.execute_cycle(SUB_ID); // too soon - next_due_at is INTERVAL seconds out
}

#[test]
fn execute_cycle_completes_subscription_on_last_cycle() {
    let vault = deploy_vault();
    let (token_disp, token) = deploy_token();
    fund(vault, token_disp, token, 1, TIER_AMOUNT, 0);

    vault.execute_cycle(SUB_ID);

    let sub = vault.get_subscription(SUB_ID);
    assert(sub.status == SubscriptionStatus::Completed, 'completed');
    assert(vault.total_active_subscriptions() == 0, 'no longer active');
}

// Exhausting the last cycle flips status to Completed (see execute_cycle_completes_subscription_
// on_last_cycle), so the next call hits the `NOT_ACTIVE` guard - `NO_CYCLES_LEFT` in the impl is
// belt-and-suspenders for a state that status transitions should already make unreachable.
#[test]
#[should_panic(expected: 'NOT_ACTIVE')]
fn execute_cycle_reverts_once_completed() {
    let vault = deploy_vault();
    let (token_disp, token) = deploy_token();
    fund(vault, token_disp, token, 1, TIER_AMOUNT, 0);
    vault.execute_cycle(SUB_ID);
    start_cheat_block_timestamp(vault.contract_address, INTERVAL * 5);
    vault.execute_cycle(SUB_ID);
}

#[test]
fn cancel_subscription_refunds_unused_escrow() {
    let vault = deploy_vault();
    let (token_disp, token) = deploy_token();
    let secret: felt252 = 'shh';
    let commitment = PoseidonTrait::new().update(secret).finalize();
    fund(vault, token_disp, token, 3, 3 * TIER_AMOUNT, commitment);

    let refund_to = stranger();
    vault.cancel_subscription(SUB_ID, secret, refund_to);

    assert(token_disp.balance_of(refund_to) == (3 * TIER_AMOUNT).into(), 'full refund');
    let sub = vault.get_subscription(SUB_ID);
    assert(sub.status == SubscriptionStatus::Cancelled, 'cancelled');
    assert(sub.escrow_balance == 0, 'escrow zeroed');
    assert(vault.total_active_subscriptions() == 0, 'no longer active after cancel');
}

#[test]
#[should_panic(expected: 'BAD_SECRET')]
fn cancel_subscription_rejects_wrong_secret() {
    let vault = deploy_vault();
    let (token_disp, token) = deploy_token();
    let commitment = PoseidonTrait::new().update('shh').finalize();
    fund(vault, token_disp, token, 1, TIER_AMOUNT, commitment);

    vault.cancel_subscription(SUB_ID, 'wrong-secret', stranger());
}

#[test]
#[should_panic(expected: 'NO_CANCEL_OFFERED')]
fn cancel_subscription_rejects_when_not_offered() {
    let vault = deploy_vault();
    let (token_disp, token) = deploy_token();
    fund(vault, token_disp, token, 1, TIER_AMOUNT, 0); // cancel_commitment = 0

    vault.cancel_subscription(SUB_ID, 'anything', stranger());
}

#[test]
fn is_due_is_false_before_funding_and_after_completion() {
    let vault = deploy_vault();
    let (token_disp, token) = deploy_token();
    assert(!vault.is_due(SUB_ID), 'unfunded is never due');

    fund(vault, token_disp, token, 1, TIER_AMOUNT, 0);
    assert(vault.is_due(SUB_ID), 'due right after funding');

    vault.execute_cycle(SUB_ID);
    assert(!vault.is_due(SUB_ID), 'not due once completed');
}
