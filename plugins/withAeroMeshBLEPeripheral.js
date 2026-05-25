/**
 * withAeroMeshBLEPeripheral — Expo config plugin placeholder for native BLE
 * peripheral advertising support.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IMPORTANT: Native BLE peripheral advertising is NOT yet implemented.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Full peripheral-mode advertising requires custom native modules on both
 * platforms:
 *
 *   Android — BluetoothLeAdvertiser
 *   ─────────────────────────────────
 *   A React Native TurboModule (or legacy NativeModule) wrapping
 *   `android.bluetooth.le.BluetoothLeAdvertiser`. The module must:
 *     • Call `BluetoothAdapter.getBluetoothLeAdvertiser()` to obtain the
 *       advertiser instance.
 *     • Build an `AdvertiseSettings` with `ADVERTISE_MODE_LOW_LATENCY` and
 *       `ADVERTISE_TX_POWER_HIGH`.
 *     • Build an `AdvertiseData` that includes:
 *         - `addServiceUuid(ParcelUuid.fromString(AEROMESH_SERVICE))`
 *         - `addManufacturerData(MANUFACTURER_ID, 18-byte SOS payload)`
 *     • Expose `startAdvertising(serviceUUID: string, payloadBase64: string)`
 *       and `stopAdvertising()` to JavaScript via the bridge.
 *     • Require the `BLUETOOTH_ADVERTISE` permission (Android 12+) and
 *       `BLUETOOTH_ADMIN` permission (Android < 12).
 *
 *   iOS — CBPeripheralManager
 *   ──────────────────────────
 *   A Swift NativeModule wrapping `CoreBluetooth.CBPeripheralManager`. The
 *   module must:
 *     • Instantiate `CBPeripheralManager(delegate:queue:)`.
 *     • In `peripheralManagerDidUpdateState`, start advertising when state
 *       is `.poweredOn`.
 *     • Call `peripheralManager.startAdvertising([
 *         CBAdvertisementDataServiceUUIDsKey: [CBUUID(string: AEROMESH_SERVICE)],
 *         CBAdvertisementDataLocalNameKey: "AeroMesh"
 *       ])`.
 *     • Add a `CBMutableCharacteristic` for `SOS_CHAR` with `.read` properties
 *       so that central peers can pull the 18-byte payload on connect.
 *     • Expose `startAdvertising(serviceUUID: String, payloadBase64: String)`
 *       and `stopAdvertising()` to JavaScript via `RCT_EXPORT_METHOD`.
 *     • Requires `NSBluetoothPeripheralUsageDescription` in Info.plist and the
 *       `bluetooth-peripheral` background mode.
 *
 * Design doc reference:
 *   .kiro/specs/aeromesh-core/design.md — Component 5: BLEMeshLayer,
 *   "Advertising (peripheral mode)" section.
 *
 * Current hackathon fallback (JS-side simulation):
 *   `src/lib/bleAdvertiser.ts` stores the current SOS payload in the
 *   `currentSosPayload` export. When a scanning peer connects and reads
 *   `SOS_CHAR` via `connectAndSync` in `ble.ts`, the payload is served from
 *   memory. This avoids the need for native peripheral support during
 *   development and hackathon demos.
 *
 * Requirements: 5.4, 3.1
 */

// This plugin is intentionally a no-op until the native modules are built.
// It is registered in app.json so that it appears in the plugin chain and
// serves as the integration point for future native code injection.

module.exports = function withAeroMeshBLEPeripheral(config) {
  // No-op: native BLE peripheral module not yet implemented.
  // See the comment block above for implementation guidance.
  return config;
};
