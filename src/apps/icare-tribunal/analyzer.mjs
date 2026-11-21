import { spawn } from 'node:child_process'

function readScoreImage(bytes, executable) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['stdin', 'stdout', '--psm', '6', 'tsv'], { stdio: ['pipe', 'pipe', 'ignore'] })
    let output = '', settled = false
    const finish = (error, result) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (error) reject(error)
      else resolve(result)
    }
    const timer = setTimeout(() => { child.kill(); finish(Error('agent_analysis_timeout')) }, 20_000)
    child.on('error', () => finish(Error('agent_ocr_unavailable')))
    child.stdin.on('error', () => {})
    child.stdout.on('data', bytes => {
      output += bytes.toString()
      if (output.length > 200_000) { child.kill(); finish(Error('agent_analysis_too_large')) }
    })
    child.on('close', code => finish(code === 0 ? null : Error('agent_ocr_failed'), output))
    child.stdin.end(bytes)
  })
}

// Conservative bundled reader for a final-score image with one player per side.
// Other HUDs use the configured analysis endpoint; unreadable images abstain.
export function scoreImageAnalyzer({ executable = 'tesseract' } = {}) {
  return async ({ question, proofs }) => {
    if (question.sidesCount !== 2 || question.players.length !== 2) return null
    const normalize = text => text.trim().toLowerCase().normalize('NFKC')
    const results = []
    for (const proof of proofs) {
      const tsv = await readScoreImage(proof.data, executable)
      const lines = new Map()
      for (const row of tsv.split('\n').slice(1)) {
        const columns = row.split('\t')
        if (columns[0] !== '5' || !columns[11]?.trim()) continue
        const key = columns.slice(1, 5).join(':')
        const line = lines.get(key) || []
        line.push({ text: columns[11], confidence: Number(columns[10]) }); lines.set(key, line)
      }
      const reliable = [...lines.values()].filter(line => line.every(word => word.confidence >= 85)).map(line => line.map(word => word.text).join(' '))
      if (!reliable.some(line => /^(final score|score final|resultat final|résultat final)$/i.test(line.trim()))) continue
      const scores = question.players.map(player => {
        const matches = reliable.map(line => /^(.*?)\s*[:|]?\s+(\d{1,3})$/.exec(line.trim()))
          .filter(result => result && normalize(result[1]) === normalize(player.pseudo))
        return matches.length === 1 ? { side: player.side, score: Number(matches[0][2]) } : null
      })
      if (scores.some(score => !score || score.score > 255)) continue
      const score1 = scores.find(score => score.side === 1)?.score, score2 = scores.find(score => score.side === 2)?.score
      if (score1 == null || score2 == null || score1 === score2) continue
      results.push({ result: { resolution: 'winner', winnerSide: score1 > score2 ? 1 : 2, score1, score2 },
        proofs: [{ proofKey: proof.proofKey, observation: reliable.join(' / ').slice(0, 2000) }] })
    }
    if (!results.length || results.some(value => JSON.stringify(value.result) !== JSON.stringify(results[0].result))) return null
    return results[0]
  }
}

export function endpointAnalyzer({ url, token }) {
  const target = new URL(url)
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))) throw Error('agent_analysis_url_invalid')
  return async ({ question, proofs }) => {
    const response = await fetch(target, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45_000),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ question, proofs: proofs.map(({ data, ...proof }) => ({ ...proof, imageBase64: data.toString('base64') })) }),
    })
    if (!response.ok) throw Error('agent_analysis_failed')
    // Stream the response with a cap: the analysis service cannot fill memory.
    let bytes = 0, chunks = []
    for await (const chunk of response.body) {
      bytes += chunk.length
      if (bytes > 32_768) throw Error('agent_analysis_too_large')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString()) // null means abstain.
  }
}
