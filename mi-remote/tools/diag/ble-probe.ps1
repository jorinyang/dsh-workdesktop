# ble-probe.ps1 —— 连上小米遥控器，把它的 GATT 服务与特征全列出来。
#
# 为什么走这条路：Raw Input 只送"系统认得的那一类"（这个遥控器只有键盘集合，所以只有方向键/OK 能收到），
# HID 直读又打不开（Windows 的 HID 驱动占着，蓝牙 LE HID 不给第二个客户端读）。
# 而 BLE 的连接是允许多客户端的 —— 实测连得上、服务也读得到。
#
# ⚠️ 不用 System.WindowsRuntimeSystemExtensions.AsTask（-File 模式下那个类型加载不到）：
#    WinRT 的 IAsyncOperation 自带 Status 与 GetResults()，轮询一下更省事、也不挑执行方式。
[Windows.Devices.Bluetooth.BluetoothLEDevice, Windows.Devices.Bluetooth, ContentType = WindowsRuntime] | Out-Null
[Windows.Devices.Bluetooth.GenericAttributeProfile.GattDeviceService, Windows.Devices.Bluetooth.GenericAttributeProfile, ContentType = WindowsRuntime] | Out-Null
[Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristic, Windows.Devices.Bluetooth.GenericAttributeProfile, ContentType = WindowsRuntime] | Out-Null

function Wait-Op($op) {
  $limit = 200
  while ($op.Status -eq 0 -and $limit -gt 0) { Start-Sleep -Milliseconds 50; $limit-- }
  if ($op.Status -ne 1) { throw ('async failed, status=' + $op.Status + ' err=' + $op.ErrorCode) }
  return $op.GetResults()
}

$addr = [uint64]0xC05D39C33846
$dev = Wait-Op ([Windows.Devices.Bluetooth.BluetoothLEDevice]::FromBluetoothAddressAsync($addr))
if ($dev -eq $null) { Write-Output 'CONNECT-FAILED'; exit 1 }
Write-Output ('CONNECTED name=' + $dev.Name + ' status=' + $dev.ConnectionStatus)

$res = Wait-Op ($dev.GetGattServicesAsync())
Write-Output ('SERVICES status=' + $res.Status + ' count=' + $res.Services.Count)
foreach ($s in $res.Services) {
  Write-Output ('SERVICE ' + $s.Uuid)
  try {
    $cr = Wait-Op ($s.GetCharacteristicsAsync())
    foreach ($c in $cr.Characteristics) {
      $props = [int]$c.CharacteristicProperties
      $mark = ''
      if (($props -band 0x10) -ne 0) { $mark = '  <<< 会通知 NOTIFY' }
      elseif (($props -band 0x20) -ne 0) { $mark = '  <<< 会指示 INDICATE' }
      Write-Output ('   CHAR ' + $c.Uuid + '  props=' + $props + $mark)
    }
  } catch {
    Write-Output ('   CHAR 读取失败: ' + $_.Exception.Message)
  }
}
