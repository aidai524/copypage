#!/usr/bin/env tsx
import { captureSite } from './site.js'
import { captureImage } from './image.js'
import { captureVideo } from './video.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--') && process.argv[process.argv.indexOf(a) - 1] !== '--out' && process.argv[process.argv.indexOf(a) - 1] !== '--image' && process.argv[process.argv.indexOf(a) - 1] !== '--video')
const url = positional[0]
const image = arg('image')
const video = arg('video')
const out = arg('out')
const maxFrames = Number(arg('max-frames') ?? '200')

if (!out || (!url && !image && !video)) {
  console.error(`usage:
  npm run capture -- <url> --out <dir>
  npm run capture -- --image <file> --out <dir>
  npm run capture -- --video <file> --out <dir> [--max-frames 200]`)
  process.exit(1)
}

if (image) {
  await captureImage(image, out)
} else if (video) {
  await captureVideo(video, out, { maxFrames })
} else {
  await captureSite(url!, out)
}
console.log(`snapshot written → ${out}`)
