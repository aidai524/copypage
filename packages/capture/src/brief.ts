import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

const boxSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })

export const briefSchema = z.object({
  regions: z.array(z.object({ name: z.string(), box: boxSchema, role: z.string().optional() })),
  components: z.array(
    z.object({
      type: z.string(),
      box: boxSchema,
      styles: z.record(z.string(), z.string()).optional(),
      notes: z.string().optional(),
    }),
  ),
  palette: z.array(z.string()),
  fonts: z.array(z.string()),
  charts: z.array(z.object({ type: z.string(), box: boxSchema })),
})

export type Brief = z.infer<typeof briefSchema>

/**
 * Write the scaffold an agent needs to produce visual-brief.json:
 * the JSON schema and a prompt referencing the captured images/frames.
 */
export async function writeBriefScaffold(
  outDir: string,
  inputType: 'image' | 'video',
): Promise<void> {
  await mkdir(outDir, { recursive: true })

  const schemaJson = z.toJSONSchema(briefSchema)
  await writeFile(
    path.join(outDir, 'visual-brief.schema.json'),
    JSON.stringify(schemaJson, null, 2),
  )

  const targets =
    inputType === 'image'
      ? '原图 `original.*` 与 `scales/2x.png`（放大版看细节）'
      : '`frames/` 下的关键帧序列（每张带时间戳 t，见 snapshot.json.frames）'

  const prompt = `# Visual Brief 任务

观察 ${targets}，输出结构化页面描述到 \`visual-brief.json\`，必须符合 \`visual-brief.schema.json\`。

要求：
1. **regions**：布局区域划分（header / hero / 卡片网格 / footer…），给出像素 box
2. **components**：每个可识别组件：type（button/card/nav/chart/…）、box、可见样式（颜色、圆角、阴影描述）、notes
3. **palette**：主色板，精确 hex（从像素取色，不要猜色名）
4. **fonts**：字体猜测（标注置信度）
5. **charts**：识别到的图表及其类型（bar/line/pie/…）与位置

注意：这份描述是**待验证假设**，后续 Verify 循环会用像素比对修正它。宁多勿漏，拿不准的写进 notes。
只输出 JSON 内容本身（写入 visual-brief.json），不要输出别的。
`
  await writeFile(path.join(outDir, 'brief-prompt.md'), prompt)
}

/** Read + validate the agent-filled visual-brief.json. Throws with zod detail on invalid. */
export async function validateBrief(dir: string): Promise<Brief> {
  const raw = await readFile(path.join(dir, 'visual-brief.json'), 'utf8')
  return briefSchema.parse(JSON.parse(raw))
}
