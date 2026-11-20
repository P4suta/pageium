import AppKit
import WebKit

DispatchQueue.global().asyncAfter(deadline: .now() + 55) {
  FileHandle.standardError.write(Data("Timed out verifying WebKit magnification.\n".utf8))
  exit(1)
}

// Exercise visible-page scheduling while the test window stays behind other windows.
final class ReaderTestWindow: NSWindow {
  override var occlusionState: NSWindow.OcclusionState { .visible }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let frame = NSRect(x: 0, y: 0, width: 1200, height: 820)
let configuration = WKWebViewConfiguration()
configuration.websiteDataStore = .nonPersistent()
let view = WKWebView(frame: frame, configuration: configuration)
view.allowsMagnification = true
let window = ReaderTestWindow(
  contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = view
window.orderBack(nil)

struct PinchFailure: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

final class TrackpadMagnification: NSEvent {
  var amount: CGFloat = 0
  var gesturePhase: NSEvent.Phase = .began
  override var type: NSEvent.EventType { .magnify }
  override var phase: NSEvent.Phase { gesturePhase }
  override var magnification: CGFloat { amount }
  override var locationInWindow: NSPoint { CGPoint(x: 645, y: 395) }
  override var timestamp: TimeInterval { ProcessInfo.processInfo.systemUptime }
}

@MainActor func waitFor(_ script: String, _ failure: String) async throws {
  for _ in 0..<90 {
    if (try? await view.evaluateJavaScript(script) as? Bool) == true { return }
    try await Task.sleep(for: .milliseconds(60))
  }
  let state =
    try? await view.evaluateJavaScript(
      """
      (() => {
        const p = \(paper), tile = p?.querySelector('.page-detail'), main = document.querySelector('main');
        const v = visualViewport, r = tile?.getBoundingClientRect();
        return JSON.stringify({ visibility: document.visibilityState, page: document.querySelector('.page-position')?.textContent,
          status: p?.dataset.status, scroll: main?.scrollTop, rect: p?.getBoundingClientRect(),
          root: document.documentElement.getBoundingClientRect(), viewport: [v.pageLeft, v.pageTop, v.width, v.height, v.scale],
          density: devicePixelRatio, tile: r, raster: tile?.width, point: window.readingPoint });
      })()
      """) as? String
  throw PinchFailure("\(failure): \(state ?? "No page state")")
}

let paper = #"document.querySelector('.pdf-page[aria-label="Page 48"]')"#
@MainActor func aligned(at density: CGFloat) -> String {
  """
  (() => {
      const p = \(paper).getBoundingClientRect(), v = visualViewport;
      const tile = \(paper).querySelector('.page-detail');
      if (!tile) return false;
      const r = tile.getBoundingClientRect();
      return Math.abs(tile.width / r.width - \(density)) < 0.08 &&
             r.left <= Math.max(0, p.left) + 1 && r.top <= Math.max(0, p.top) + 1 &&
             r.right >= Math.min(v.width, p.right) - 1 && r.bottom >= Math.min(v.height, p.bottom) - 1;
  })()
  """
}

@MainActor func checkInk() async throws {
  let image = try await view.takeSnapshot(configuration: nil)
  guard let data = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: data) else {
    throw PinchFailure("Missing WebKit snapshot")
  }
  for x in [0.25, 0.50, 0.75] {
    for y in [0.35, 0.50, 0.65] {
      let color = bitmap.colorAt(
        x: Int(x * Double(bitmap.pixelsWide)), y: Int(y * Double(bitmap.pixelsHigh)))?
        .usingColorSpace(.sRGB)
      guard let color, color.blueComponent - color.redComponent > 0.09,
        color.greenComponent - color.redComponent > 0.06
      else {
        throw PinchFailure("Missing ink in the magnified paper at \(x), \(y)")
      }
    }
  }
}

@MainActor func checkTrackpad() async throws {
  let x = 645
  let y = Int(frame.height) - 395
  _ = try await view.evaluateJavaScript(
    """
    window.addEventListener('gesturestart', event => {
      const r = \(paper).getBoundingClientRect();
      const pane = document.querySelector('main');
      window.readingPoint = { width: r.width, height:r.height, top:r.top, scroll:pane.scrollTop,
        paneHeight:pane.clientHeight, clientX:event.clientX, clientY:event.clientY,
        x: (event.clientX-r.left)/r.width, y: (event.clientY-r.top)/r.height };
    }, { capture: true, once: true });
    """)
  func magnify(_ phase: NSEvent.Phase, _ amount: CGFloat) {
    let event = TrackpadMagnification()
    event.gesturePhase = phase
    event.amount = amount
    view.magnify(with: event)
  }
  func checkPoint(_ scale: CGFloat) async throws {
    do {
      try await waitFor(
        """
        (() => { const r = \(paper).getBoundingClientRect(), p = readingPoint;
          return visualViewport.scale === 1 && Math.abs(r.width / p.width - \(scale)) < 0.015 &&
            Math.abs(r.left + p.x*r.width - \(x)) < 2 && Math.abs(r.top + p.y*r.height - \(y)) < 2; })()
        """, "Trackpad lost the reading point at \(scale)x")
    } catch {
      let state =
        try await view.evaluateJavaScript(
          """
          (() => { const r = \(paper).getBoundingClientRect(), p = readingPoint;
            return JSON.stringify({root:visualViewport.scale, actual:r.width/p.width,
            dx:r.left+p.x*r.width-\(x), dy:r.top+p.y*r.height-\(y), start:p,
            scroll:document.querySelector('main').scrollTop, paneHeight:document.querySelector('main').clientHeight,
            top:r.top, height:r.height, transform:\(paper).style.transform}); })()
          """) as? String
      throw PinchFailure("\(error): \(state ?? "missing sample")")
    }
  }
  magnify(.began, 0)
  try await waitFor(
    "typeof readingPoint !== 'undefined' && readingPoint.y > 0 && readingPoint.y < 1",
    "The trackpad gesture did not start on the saved page")
  var scale: CGFloat = 1
  for factor: CGFloat in [1.25, 1.6, 2, 2, 1.25, 0.75, 0.5] {
    magnify(.changed, factor - 1)
    scale = min(8, scale * factor)
    try await checkPoint(scale)
    if scale >= 6 { try await checkInk() }
  }
  magnify(.ended, 0)
  try await waitFor(aligned(at: window.backingScaleFactor), "Paper detail did not settle")
  try await checkPoint(scale)
  _ = try await view.evaluateJavaScript(
    "window.dispatchEvent(new KeyboardEvent('keydown', {key:'0'}))")
  try await waitFor(
    "Math.abs(\(paper).getBoundingClientRect().width / readingPoint.width - 1) < 0.001",
    "Reader zoom did not reset")
}

@MainActor func checkPinch() async throws {
  guard let address = CommandLine.arguments.dropFirst().first, let url = URL(string: address) else {
    throw PinchFailure("Missing test URL")
  }
  view.load(URLRequest(url: url))
  try await waitFor("document.visibilityState === 'visible'", "WebKit did not expose the reader")
  try await waitFor("\(paper)?.querySelector('canvas') != null", "Saved page did not render")
  try await checkTrackpad()
  for scale: CGFloat in [1.6, 2.1, 2.6, 3, 4.5, 6, 8, 6.5, 4, 2, 1] {
    view.setMagnification(scale, centeredAt: CGPoint(x: 610, y: 395))
    try await waitFor("Math.abs(visualViewport.scale - \(scale)) < 0.02", "Missing native zoom")
    _ = try await view.evaluateJavaScript(
      """
      { const r = \(paper).getBoundingClientRect(), v = visualViewport;
        window.scrollTo(scrollX + r.x + r.width * 0.48 - v.width / 2,
                        scrollY + r.y + r.height * 0.52 - v.height / 2); }
      """)
    if scale >= 2 { try await checkInk() }
    if [1.6, 3, 8, 4, 2].contains(scale) {
      try await waitFor(
        aligned(at: scale * window.backingScaleFactor),
        "Visible detail did not match the display at \(scale)x")
    } else if scale == 1 {
      try await waitFor("\(paper).querySelector('.page-detail') == null", "Zoom did not reset")
    }
  }
}

Task { @MainActor in
  do {
    try await checkPinch()
    app.terminate(nil)
  } catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
  }
}
app.run()
