import AppKit
import Foundation
import WebKit

final class AssetRenderer: NSObject, WKNavigationDelegate {
  private let inputURL: URL
  private let outputURL: URL
  private let size: CGSize
  private let webView: WKWebView

  init(inputURL: URL, outputURL: URL, size: CGSize) {
    self.inputURL = inputURL
    self.outputURL = outputURL
    self.size = size
    self.webView = WKWebView(frame: CGRect(origin: .zero, size: size))
    super.init()
    self.webView.navigationDelegate = self
  }

  func start() {
    let accessURL = inputURL.deletingLastPathComponent()
    webView.loadFileURL(inputURL, allowingReadAccessTo: accessURL)
    RunLoop.main.run()
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    let configuration = WKSnapshotConfiguration()
    configuration.rect = CGRect(origin: .zero, size: size)

    webView.takeSnapshot(with: configuration) { [self] image, error in
      if let error {
        fputs("Snapshot failed: \(error.localizedDescription)\n", stderr)
        exit(1)
      }

      guard let image,
            let tiffData = image.tiffRepresentation,
            let bitmap = NSBitmapImageRep(data: tiffData),
            let pngData = bitmap.representation(using: .png, properties: [:]) else {
        fputs("Could not encode PNG data.\n", stderr)
        NSApp.terminate(nil)
        exit(1)
      }

      do {
        try pngData.write(to: outputURL)
        exit(0)
      } catch {
        fputs("Could not write output: \(error.localizedDescription)\n", stderr)
        exit(1)
      }
    }
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    fputs("Navigation failed: \(error.localizedDescription)\n", stderr)
    exit(1)
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    fputs("Initial load failed: \(error.localizedDescription)\n", stderr)
    exit(1)
  }
}

guard CommandLine.arguments.count == 5 else {
  fputs("Usage: swift scripts/render_asset.swift <input.svg> <output.png> <width> <height>\n", stderr)
  exit(1)
}

let inputPath = CommandLine.arguments[1]
let outputPath = CommandLine.arguments[2]

guard let width = Double(CommandLine.arguments[3]),
      let height = Double(CommandLine.arguments[4]) else {
  fputs("Width and height must be numbers.\n", stderr)
  exit(1)
}

let inputURL = URL(fileURLWithPath: inputPath)
let outputURL = URL(fileURLWithPath: outputPath)
let size = CGSize(width: width, height: height)

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

let renderer = AssetRenderer(inputURL: inputURL, outputURL: outputURL, size: size)
renderer.start()
