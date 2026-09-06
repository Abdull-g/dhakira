import { execFile } from 'node:child_process'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

describe('symlinked CLI entrypoint', () => {
  let tempDir: string
  let cliSymlink: string

  beforeAll(async () => {
    await execFileAsync('npm', ['run', 'build'])

    tempDir = await mkdtemp(join(tmpdir(), 'dhakira-cli-'))
    cliSymlink = join(tempDir, 'dhakira')
    await symlink(join(process.cwd(), 'dist/cli.js'), cliSymlink)
    // `npm run build` (tsc + asset copy) takes ~15 s alone and can exceed 30 s
    // when the whole suite runs in parallel — that made this test flaky.
  }, 120_000)

  afterAll(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('runs commands when invoked through an npm-style symlink', async () => {
    const { stdout } = await execFileAsync(process.execPath, [cliSymlink, 'help'])

    expect(stdout).toContain('dhakira')
    expect(stdout).toContain('Usage:')
    expect(stdout).toContain('Commands:')

    await expect(execFileAsync(process.execPath, [cliSymlink, '__nonsense_command_xyz'])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Unknown command'),
    })
  })
})
