# read-battery.ps1 -- read the remote's battery level over BLE.
#
# ASCII only on purpose: cmd/powershell read this file as GBK while the write tool
# emits UTF-8, so Chinese text here would turn into garbage.
#
# The remote exposes the standard Battery Service:
#   Service        0000180F-0000-1000-8000-00805f9b34fb
#   Characteristic 00002A19-0000-1000-8000-00805f9b34fb   (Battery Level, one byte = percent)
#
# Usage: powershell -File read-battery.ps1 [-Address 0xC05D39C33846] [-Json]
# Prints {"ok":true,"level":85} or {"ok":false,"error":"..."}.
param(
  [string]$Address = '0xC05D39C33846',
  [switch]$Json
)

$ErrorActionPreference = 'Stop'

function Emit($obj) {
  # Same contract as the other helper scripts in this directory: the host only
  # parses lines prefixed with RESULT_JSON= (see runScript in lib/index.js).
  Write-Output ('RESULT_JSON=' + ($obj | ConvertTo-Json -Compress))
}

try {
  [Windows.Devices.Bluetooth.BluetoothLEDevice, Windows.Devices.Bluetooth, ContentType = WindowsRuntime] | Out-Null
  [Windows.Devices.Bluetooth.GenericAttributeProfile.GattDeviceService, Windows.Devices.Bluetooth.GenericAttributeProfile, ContentType = WindowsRuntime] | Out-Null
  [Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristic, Windows.Devices.Bluetooth.GenericAttributeProfile, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null

  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  function Await($op, $type) {
    $m = $asTaskGeneric.MakeGenericMethod($type)
    $t = $m.Invoke($null, @($op))
    $t.Wait(-1) | Out-Null
    $t.Result
  }

  $addr = [uint64]$Address
  $dev = Await ([Windows.Devices.Bluetooth.BluetoothLEDevice]::FromBluetoothAddressAsync($addr)) ([Windows.Devices.Bluetooth.BluetoothLEDevice])
  if ($dev -eq $null) { Emit @{ ok = $false; error = 'connect-failed' }; exit 1 }

  $svcRes = Await ($dev.GetGattServicesAsync()) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattDeviceServicesResult])
  $batterySvc = $null
  foreach ($s in $svcRes.Services) {
    if ($s.Uuid.ToString().ToLower().StartsWith('0000180f')) { $batterySvc = $s; break }
  }
  if ($batterySvc -eq $null) { Emit @{ ok = $false; error = 'no-battery-service' }; exit 1 }

  $charRes = Await ($batterySvc.GetCharacteristicsAsync()) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristicsResult])
  $levelChar = $null
  foreach ($c in $charRes.Characteristics) {
    if ($c.Uuid.ToString().ToLower().StartsWith('00002a19')) { $levelChar = $c; break }
  }
  if ($levelChar -eq $null) { Emit @{ ok = $false; error = 'no-battery-level' }; exit 1 }

  $read = Await ($levelChar.ReadValueAsync()) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattReadResult])
  if ($read.Status.ToString() -ne 'Success') { Emit @{ ok = $false; error = 'read-status-' + $read.Status.ToString() }; exit 1 }

  # Read the IBuffer.
  # What does NOT work here (all tried):
  #   DataReader.FromBuffer($read.Value)                  -> cannot convert System.__ComObject to IBuffer
  #   [WindowsRuntimeBufferExtensions]::ToArray($buf)     -> cannot find an overload (PowerShell binds the COM object wrongly)
  #   Add-Type with a typed helper                        -> cannot resolve Windows.Storage.Streams (no WinRT metadata)
  # Reflection sidesteps PowerShell's overload resolution and works.
  if (-not $script:toArrayMethod) {
    $ext = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]
    $script:toArrayMethod = $ext.GetMethods() |
      Where-Object { $_.Name -eq 'ToArray' -and $_.GetParameters().Count -eq 1 } |
      Select-Object -First 1
  }
  $bytes = $script:toArrayMethod.Invoke($null, @($read.Value))
  if ($bytes.Length -lt 1) { Emit @{ ok = $false; error = 'empty' }; exit 1 }

  Emit @{ ok = $true; level = [int]$bytes[0]; raw = ($bytes | ForEach-Object { $_.ToString('X2') }) -join ' ' }
  exit 0
} catch {
  Emit @{ ok = $false; error = $_.Exception.Message }
  exit 1
}
