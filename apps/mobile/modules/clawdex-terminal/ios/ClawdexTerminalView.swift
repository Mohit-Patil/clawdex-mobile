import ExpoModulesCore
import UIKit

final class ClawdexTerminalView: ExpoView {
  let onReady = EventDispatcher()
  let onInput = EventDispatcher()
  let onTerminalResize = EventDispatcher()

  private let canvasView = ClawdexTerminalCanvasView()
  private var runtime = ClawdexGhosttyRuntime(cols: 80, rows: 24)
  private var lastAppliedWriteSeq = -1
  private var readyDispatched = false
  private var lastResizeSignature: String?

  var sessionId: String? {
    didSet {
      dispatchReadyIfNeeded()
      refreshDisplay()
    }
  }

  var placeholderText = "Waiting for terminal output..." {
    didSet {
      canvasView.placeholderText = placeholderText
      refreshDisplay()
    }
  }

  private(set) var cols = 80
  private(set) var rows = 24

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = ClawdexTerminalCanvasView.palette.background
    canvasView.placeholderText = placeholderText
    addSubview(canvasView)
    refreshDisplay()
  }

  override func layoutSubviews() {
    canvasView.frame = bounds
    dispatchReadyIfNeeded()
    emitResizeSuggestionIfNeeded()
  }

  func setGrid(cols: Int, rows: Int) {
    let nextCols = max(cols, 1)
    let nextRows = max(rows, 1)
    guard nextCols != self.cols || nextRows != self.rows else {
      return
    }

    self.cols = nextCols
    self.rows = nextRows
    canvasView.setGrid(cols: nextCols, rows: nextRows)
    runtime.resize(cols: nextCols, rows: nextRows)
    refreshDisplay()
  }

  func applyWriteFrame(_ frame: [String: Any]?) {
    guard
      let frame,
      let seq = frame["seq"] as? Int,
      seq > lastAppliedWriteSeq
    else {
      return
    }

    lastAppliedWriteSeq = seq
    if let dataBase64 = frame["dataBase64"] as? String,
       let snapshot = runtime.write(base64: dataBase64)
    {
      canvasView.applySnapshot(snapshot)
      return
    }

    refreshDisplay()
  }

  private func refreshDisplay() {
    if let snapshot = runtime.snapshot(), !snapshot.text.isEmpty {
      canvasView.applySnapshot(snapshot)
      return
    }

    canvasView.applyPlaceholder(
      message: ClawdexGhosttyRuntime.rendererInfo.message,
      sessionId: sessionId,
      cols: cols,
      rows: rows
    )
  }

  private func dispatchReadyIfNeeded() {
    guard !readyDispatched, window != nil else {
      return
    }

    readyDispatched = true
    onReady(ClawdexGhosttyRuntime.rendererInfo.asDictionary(sessionId: sessionId))
  }

  private func emitResizeSuggestionIfNeeded() {
    let pixelWidth = Int(bounds.width.rounded(.down))
    let pixelHeight = Int(bounds.height.rounded(.down))
    guard pixelWidth > 0, pixelHeight > 0 else {
      return
    }

    let grid = canvasView.gridSize(for: bounds.size)
    let signature = "\(grid.cols)x\(grid.rows):\(pixelWidth)x\(pixelHeight)"
    guard signature != lastResizeSignature else {
      return
    }

    lastResizeSignature = signature
    onTerminalResize([
      "sessionId": sessionId ?? NSNull(),
      "cols": grid.cols,
      "rows": grid.rows,
      "pixelWidth": pixelWidth,
      "pixelHeight": pixelHeight,
    ])
  }
}

private final class ClawdexTerminalCanvasView: UIView {
  struct Palette {
    let background = UIColor(red: 5 / 255, green: 6 / 255, blue: 7 / 255, alpha: 1)
    let foreground = UIColor(red: 243 / 255, green: 244 / 255, blue: 248 / 255, alpha: 1)
    let muted = UIColor(red: 156 / 255, green: 163 / 255, blue: 175 / 255, alpha: 1)
    let cursorBackground = UIColor(red: 243 / 255, green: 244 / 255, blue: 248 / 255, alpha: 1)
    let cursorForeground = UIColor(red: 5 / 255, green: 6 / 255, blue: 7 / 255, alpha: 1)
  }

  static let palette = Palette()

  var placeholderText = "Waiting for terminal output..."

  private let font = UIFont.monospacedSystemFont(ofSize: 13, weight: .regular)
  private let inset = UIEdgeInsets(top: 14, left: 14, bottom: 14, right: 14)
  private var textAttributes: [NSAttributedString.Key: Any]
  private var cursorAttributes: [NSAttributedString.Key: Any]
  private var lines: [String]
  private var cursorX = 0
  private var cursorY = 0
  private var cursorVisible = false
  private var cols = 80
  private var rows = 24
  private let cellWidth: CGFloat
  private let cellHeight: CGFloat
  private let baselineOffset: CGFloat

  override init(frame: CGRect) {
    let paragraphStyle = NSMutableParagraphStyle()
    paragraphStyle.lineBreakMode = .byClipping
    paragraphStyle.maximumLineHeight = 18
    paragraphStyle.minimumLineHeight = 18

    let sample = "W" as NSString
    let measuredCell = sample.size(withAttributes: [.font: font])
    cellWidth = ceil(measuredCell.width)
    cellHeight = 18
    baselineOffset = floor((cellHeight - font.lineHeight) / 2)
    textAttributes = [
      .font: font,
      .foregroundColor: Self.palette.foreground,
      .paragraphStyle: paragraphStyle,
    ]
    cursorAttributes = [
      .font: font,
      .foregroundColor: Self.palette.cursorForeground,
      .paragraphStyle: paragraphStyle,
    ]
    lines = Array(repeating: "", count: rows)
    super.init(frame: frame)
    backgroundColor = Self.palette.background
    contentMode = .redraw
    isOpaque = true
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  func gridSize(for size: CGSize) -> (cols: Int, rows: Int) {
    let availableWidth = max(0, size.width - inset.left - inset.right)
    let availableHeight = max(0, size.height - inset.top - inset.bottom)
    return (
      cols: max(Int(floor(availableWidth / cellWidth)), 2),
      rows: max(Int(floor(availableHeight / cellHeight)), 1)
    )
  }

  func setGrid(cols: Int, rows: Int) {
    self.cols = max(cols, 1)
    self.rows = max(rows, 1)
    lines = normalizedLines(lines, rows: self.rows, cols: self.cols)
    setNeedsDisplay()
  }

  func applySnapshot(_ snapshot: ClawdexGhosttyTextSnapshot) {
    let nextLines = normalizedLines(
      snapshot.text.components(separatedBy: "\n"),
      rows: rows,
      cols: cols
    )
    let previousLines = lines
    let previousCursorRect = cursorVisible ? rectForCell(x: cursorX, y: cursorY) : nil

    lines = nextLines
    cursorX = max(0, min(snapshot.cursorX, max(cols - 1, 0)))
    cursorY = max(0, min(snapshot.cursorY, max(rows - 1, 0)))
    cursorVisible = snapshot.cursorVisible && !snapshot.text.isEmpty

    var invalidRows = IndexSet()
    for row in 0..<rows {
      let previous = row < previousLines.count ? previousLines[row] : ""
      let next = row < nextLines.count ? nextLines[row] : ""
      if previous != next {
        invalidRows.insert(row)
      }
    }

    if invalidRows.isEmpty {
      setNeedsDisplay(previousCursorRect ?? rectForCell(x: cursorX, y: cursorY))
      setNeedsDisplay(rectForCell(x: cursorX, y: cursorY))
      return
    }

    for range in invalidRows.rangeView {
      setNeedsDisplay(rectForRows(range))
    }
    if let previousCursorRect {
      setNeedsDisplay(previousCursorRect)
    }
    if cursorVisible {
      setNeedsDisplay(rectForCell(x: cursorX, y: cursorY))
    }
  }

  func applyPlaceholder(message: String, sessionId: String?, cols: Int, rows: Int) {
    let sessionLine = sessionId.map { "Session: \($0)" } ?? "Session: pending"
    lines = normalizedLines(
      [
        placeholderText,
        "",
        sessionLine,
        "Grid: \(cols)x\(rows)",
        "",
        message,
      ],
      rows: self.rows,
      cols: self.cols
    )
    cursorVisible = false
    setNeedsDisplay()
  }

  override func draw(_ rect: CGRect) {
    guard let context = UIGraphicsGetCurrentContext() else {
      return
    }

    context.setFillColor(Self.palette.background.cgColor)
    context.fill(rect)

    let firstRow = max(0, Int(floor((rect.minY - inset.top) / cellHeight)))
    let lastRow = min(rows - 1, Int(ceil((rect.maxY - inset.top) / cellHeight)))
    guard firstRow <= lastRow else {
      return
    }

    for row in firstRow...lastRow {
      guard row < lines.count else {
        continue
      }
      drawLine(lines[row], row: row)
    }

    if cursorVisible && cursorY >= firstRow && cursorY <= lastRow {
      drawCursor()
    }
  }

  private func drawLine(_ line: String, row: Int) {
    let clipped = line.count > cols ? String(line.prefix(cols)) : line
    let origin = CGPoint(
      x: inset.left,
      y: inset.top + CGFloat(row) * cellHeight + baselineOffset
    )
    (clipped as NSString).draw(at: origin, withAttributes: textAttributes)
  }

  private func drawCursor() {
    let cursorRect = rectForCell(x: cursorX, y: cursorY)
    Self.palette.cursorBackground.setFill()
    UIBezierPath(rect: cursorRect).fill()

    let line = cursorY < lines.count ? lines[cursorY] : ""
    let character = characterAt(line, index: cursorX)
    let origin = CGPoint(x: cursorRect.minX, y: cursorRect.minY + baselineOffset)
    (character as NSString).draw(at: origin, withAttributes: cursorAttributes)
  }

  private func normalizedLines(_ rawLines: [String], rows: Int, cols: Int) -> [String] {
    var normalized = rawLines.prefix(rows).map { line in
      line.count > cols ? String(line.prefix(cols)) : line
    }
    while normalized.count < rows {
      normalized.append("")
    }
    return normalized
  }

  private func characterAt(_ line: String, index: Int) -> String {
    guard index >= 0, index < line.count else {
      return " "
    }
    let stringIndex = line.index(line.startIndex, offsetBy: index)
    return String(line[stringIndex])
  }

  private func rectForCell(x: Int, y: Int) -> CGRect {
    CGRect(
      x: inset.left + CGFloat(max(x, 0)) * cellWidth,
      y: inset.top + CGFloat(max(y, 0)) * cellHeight,
      width: cellWidth,
      height: cellHeight
    )
  }

  private func rectForRows(_ range: Range<Int>) -> CGRect {
    CGRect(
      x: 0,
      y: inset.top + CGFloat(range.lowerBound) * cellHeight,
      width: bounds.width,
      height: CGFloat(range.count) * cellHeight
    )
  }
}
