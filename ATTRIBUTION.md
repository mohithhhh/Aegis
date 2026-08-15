# Attribution

Aegis's frontend plumbing (wallet connection, shield/unshield/private-transfer UI,
the `WalletAccountV6` STRK20 action wiring, and the `StrkInvokeHelper` demo
anonymizer contract in [contracts/echo-helper](contracts/echo-helper)) is vendored
from the **STRK20 starter kit**:

- Repo: https://github.com/Akashneelesh/strk20-starter-kit
- Itself bootstrapped from [PhilippeR26/Starknet-WalletAccount](https://github.com/PhilippeR26/Starknet-WalletAccount)
- License: MIT (Copyright (c) 2023 Philippe ROSTAN)

Both the starter kit and this repository are MIT licensed; see [LICENSE](LICENSE)
for Aegis's own license terms.

The custom subscription-authorization contract, keeper/renewal logic, and
subscriber/creator UI built on top of this plumbing are original work for the
STRK20 Private Sprint hackathon (see [README.md](README.md)).
