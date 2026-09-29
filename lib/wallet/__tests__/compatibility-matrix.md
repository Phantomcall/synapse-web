# Wallet-Kit Compatibility Test Matrix

This matrix tracks compatibility and test coverage across all supported Stellar wallets for Synapse Web.

## Supported Wallets & Capabilities Matrix

| Wallet | Type | Connect | Sign Tx (XDR) | Disconnect | Network Switch | Account Switch | Test Mode | Status |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Freighter** | Browser Extension | Pass | Pass | Pass | Pass | Pass | Automated & Manual | Supported |
| **xBull** | Browser Extension | Pass | Pass | Pass | Pass | Pass | Automated & Manual | Supported |
| **Ledger** | Hardware Device (USB/BLE) | Pass | Pass | Pass | Pass | Pass | Boundary Mock + Manual | Supported |
| **WalletConnect** | Mobile / QR Bridge | Pass | Pass | Pass | Pass | Pass | Boundary Mock + Manual | Supported |

---

## Release Verification Checklist

Re-run before every production and testnet release:

- [ ] Automated Compatibility Suite passes (`npm test lib/wallet/__tests__/compatibility.test.ts`)
- [ ] Manual verification on Chrome (Freighter Extension latest)
- [ ] Manual verification on Firefox/Brave (xBull Extension latest)
- [ ] Manual verification with physical Ledger device (Stellar App v4.0+)
- [ ] Manual verification with WalletConnect mobile app (e.g., LOBSTR / Solar)

---

## Automated vs. Manual Boundary

| Feature / Flow | Automated Coverage | Manual Requirement |
| :--- | :--- | :--- |
| **Connection Handshake** | Mocked `authModal` & `getAddress` resolution for all wallet IDs | Visual modal inspection in real browser extension |
| **Transaction Signing** | Mocked `signTransaction` with valid/invalid XDR payloads & user rejects | Actual device confirmation / PIN entry / biometric approval |
| **Disconnection** | Local storage clearing + module disconnect callback verification | Extension session revocation |
| **Account Switch** | Event emission, listener trigger, address state updates | Switching account inside extension popup |
| **Network Switch** | Network ID propagation (Testnet / Public / Futurenet) | Extension network selector sync |

---

## Manual Test Procedures

### 1. Freighter Extension
1. **Prerequisites**: Install Freighter from [freighter.app](https://www.freighter.app/). Set network to **Testnet**.
2. **Connect**: Click "Connect Wallet" -> Select "Freighter". Approve access in popup. Verify displayed address matches Freighter.
3. **Sign Transaction**: Trigger a contract invocation or bridge deposit. Verify the transaction prompt shows correct memo/ops, then click "Approve". Verify TX hash returned.
4. **Account Switch**: In Freighter popup, switch to a second testnet account. Verify UI updates active account immediately.
5. **Disconnect**: Click user badge / Disconnect. Verify session is wiped and UI resets to "Connect Wallet".

### 2. xBull Extension
1. **Prerequisites**: Install xBull from [xbull.app](https://xbull.app/). Unlock wallet on Testnet.
2. **Connect**: Click "Connect Wallet" -> Select "xBull". Verify popup requests approval and active address is loaded.
3. **Sign Transaction**: Submit a transaction. Verify xBull opens confirmation window, approve it, verify completion.
4. **Network Switch**: Switch between Testnet and Futurenet/Public in settings. Verify kit receives network configuration.
5. **Disconnect**: Disconnect and confirm storage keys `synapse_selected_wallet_id` are removed.

### 3. Ledger Hardware Wallet
1. **Prerequisites**: Ledger Nano S/X/Flex connected via USB/WebHID. Open Stellar app on Ledger device (enable hash signing if needed).
2. **Connect**: Select Ledger in kit modal -> Confirm WebHID device pairing prompt -> Verify public key is read accurately.
3. **Sign Transaction**: Dispatch transaction -> Verify prompt appears on physical Ledger screen -> Verify fees, destination, amount -> Confirm on hardware buttons.
4. **Reject Handling**: Reject transaction on hardware -> Verify UI displays `Transaction rejected by user` error banner gracefully without crashing.
5. **Disconnect**: Unplug device or click Disconnect -> Verify app returns to disconnected state cleanly.

### 4. WalletConnect (Mobile QR Flow)
1. **Prerequisites**: Mobile wallet with Stellar support (e.g., LOBSTR / Solar).
2. **Connect**: Select WalletConnect -> Scan displayed QR code with mobile camera/app -> Approve pairing on phone -> Verify desktop dashboard reflects mobile account.
3. **Sign Transaction**: Initiate tx on desktop -> Verify push notification / sign request on phone -> Approve on phone -> Verify desktop completes action.
4. **Session Termination**: Terminate session from mobile wallet settings -> Verify desktop tab reflects disconnected status.

---

## Maintenance & Extension Guidelines

Whenever a new wallet adapter is added or `@creit.tech/stellar-wallets-kit` is upgraded:
1. Update `lib/wallet/kit.ts` with the new module definition.
2. Add corresponding mockable flow tests to `lib/wallet/__tests__/compatibility.test.ts`.
3. Add a row and manual verification instructions to this matrix file.
