import CoreAudio
import Foundation

func devices() -> [AudioObjectID] {
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDevices,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size)
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids)
  return ids
}

func string(_ id: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String {
  var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size = UInt32(MemoryLayout<CFString?>.size)
  var out: CFString? = nil
  let st = withUnsafeMutablePointer(to: &out) { AudioObjectGetPropertyData(id, &addr, 0, nil, &size, $0) }
  return st == noErr ? (out as String? ?? "") : ""
}

func inputChannels(_ id: AudioObjectID) -> Int {
  var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
  let ptr = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: 16)
  defer { ptr.deallocate() }
  guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, ptr) == noErr else { return 0 }
  let lists = ptr.assumingMemoryBound(to: AudioBufferList.self)
  return Int(UnsafeMutableAudioBufferListPointer(lists).reduce(0) { $0 + $1.mNumberChannels })
}

var rows: [[String: Any]] = []
for id in devices() {
  let name = string(id, kAudioObjectPropertyName)
  let uid = string(id, kAudioDevicePropertyDeviceUID)
  rows.append(["name": name, "uid": uid, "inputs": inputChannels(id)])
}
let data = try! JSONSerialization.data(withJSONObject: rows, options: [.prettyPrinted])
print(String(data: data, encoding: .utf8)!)
