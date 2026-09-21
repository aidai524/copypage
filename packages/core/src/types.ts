export interface BoxModel {
  x: number
  y: number
  width: number
  height: number
}

export interface ComputedStyles {
  fontFamily: string
  fontSize: string
  fontWeight: string
  lineHeight: string
  color: string
  backgroundColor: string
  backgroundImage: string
  borderRadius: string
  boxShadow: string
  border: string
  padding: string
  margin: string
  transform: string
  opacity: string
  zIndex: string
  display: string
  position: string
}

export interface ElementNode {
  /** stable path id, e.g. "0/2/1" */
  id: string
  tag: string
  selector: string
  box: BoxModel
  styles: ComputedStyles
  text?: string
  /** semantic attributes: img.src, a.href, video src/poster */
  attrs?: Record<string, string>
  children: ElementNode[]
}

export interface DomSnapshot {
  url: string
  viewport: { width: number; height: number }
  capturedAt: string
  root: ElementNode
}

export interface SnapshotMeta {
  title: string
  favicon?: string
  backgroundColor: string
  colorScheme: 'light' | 'dark'
}

export interface SnapshotInput {
  type: 'url' | 'image' | 'video'
  source: string
}

export interface VideoFrame {
  file: string
  t: number
}

export interface Snapshot {
  input: SnapshotInput
  viewports: number[]
  /** viewport width (as string) -> screenshot path relative to snapshot dir */
  screenshots: Record<string, string>
  /** per-viewport DOM snapshots, url input only */
  dom?: DomSnapshot[]
  assetsDir?: string
  frames?: VideoFrame[]
  /** path to visual-brief.json relative to snapshot dir */
  brief?: string
  /** path to charts.json relative to snapshot dir */
  charts?: string
}
