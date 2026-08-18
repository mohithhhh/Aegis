//! Minimal ERC20 stand-in for tests: just enough `balance_of` / `transfer` / `mint` to exercise
//! the vault's `IErc20Dispatcher` calls without pulling in a real token contract. Entrypoint names
//! match `super::super::IErc20`, so the vault's dispatcher calls resolve by selector regardless of
//! which trait declared them.
use starknet::ContractAddress;

#[starknet::interface]
pub trait IMockErc20<TState> {
    fn balance_of(self: @TState, account: ContractAddress) -> u256;
    fn transfer(ref self: TState, recipient: ContractAddress, amount: u256) -> bool;
    fn mint(ref self: TState, recipient: ContractAddress, amount: u256);
}

#[starknet::contract]
pub mod MockErc20 {
    use starknet::ContractAddress;
    use starknet::get_caller_address;
    use starknet::storage::{Map, StorageMapReadAccess, StorageMapWriteAccess};

    #[storage]
    struct Storage {
        balances: Map<ContractAddress, u256>,
    }

    #[abi(embed_v0)]
    impl MockErc20Impl of super::IMockErc20<ContractState> {
        fn balance_of(self: @ContractState, account: ContractAddress) -> u256 {
            self.balances.read(account)
        }

        fn transfer(ref self: ContractState, recipient: ContractAddress, amount: u256) -> bool {
            let caller = get_caller_address();
            let caller_balance = self.balances.read(caller);
            assert(caller_balance >= amount, 'INSUFFICIENT_BALANCE');
            self.balances.write(caller, caller_balance - amount);
            self.balances.write(recipient, self.balances.read(recipient) + amount);
            true
        }

        fn mint(ref self: ContractState, recipient: ContractAddress, amount: u256) {
            self.balances.write(recipient, self.balances.read(recipient) + amount);
        }
    }
}
