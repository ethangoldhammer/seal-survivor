// Decodes QR codes out of PNG files, one line of output per file:
//
//     <path>\t<how many>\t<payload> | <payload> | ...
//
// The COUNT is not a detail. A contact sheet made of kill shots that each
// carry their own code would decode perfectly well while being a mess — three
// codes in one picture, two of them shrunk past scanning — and a harness that
// only looks at the first payload calls that a pass.
//
// Used by tools/qr-test.mjs. The point of it is that nothing in this repo is
// allowed to be the judge of whether path/src/qr.js produces a real QR code —
// a matrix can be self-consistently wrong in a dozen ways (a bad block table,
// an inverted mask, format bits for the wrong level) and every one of them
// still LOOKS like a QR code. macOS ships a scanner; this asks it.
//
// Run: swift tools/qr-decode.swift a.png b.png ...
// Takes every file in one process, because `swift` compiles the script on each
// invocation and that is the slow part, not the decoding.

import Foundation
import Vision
import CoreImage

let paths = Array(CommandLine.arguments.dropFirst())

for path in paths {
    let url = URL(fileURLWithPath: path)
    guard let image = CIImage(contentsOf: url) else {
        print("\(path)\t0\tNOFILE")
        continue
    }
    let request = VNDetectBarcodesRequest()
    request.symbologies = [.qr]
    let handler = VNImageRequestHandler(ciImage: image, options: [:])
    var payloads: [String] = []
    do {
        try handler.perform([request])
        payloads = (request.results ?? []).compactMap { $0.payloadStringValue }
    } catch {
        print("\(path)\t0\tERROR \(error)")
        continue
    }
    let joined = payloads.isEmpty ? "NONE" : payloads.joined(separator: " | ")
    print("\(path)\t\(payloads.count)\t\(joined.replacingOccurrences(of: "\t", with: " "))")
}
