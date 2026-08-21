'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import FluidOrb from '@/components/fluid-orb'
import {
  attachLiveSession,
  type LiveSession,
  type LiveTurn,
  type LiveVoice,
} from 'chatgpt-oauth/realtime'

/**
 * A full-duplex call, not a turn-based one.
 *
 * The mic stays open for the whole session and the model decides when to talk. There is no send
 * button and no push-to-talk, because there is no request/response cycle to attach one to: both
 * sides stream continuously and their turns overlap.
 *
 * The protocol lives in `chatgpt-oauth/realtime`. What is left here is the parts that are
 * genuinely this app's: the peer connection, the delegate call, and the UI.
 */
type Phase = 'idle' | 'connecting' | 'listening' | 'delegating' | 'speaking'

/** The orb is the only status indicator, so each phase gets a colour you can read at a glance. */
const PHASE_COLOR: Record<Phase, string> = {
  idle: '#4C4F6B',
  connecting: '#4C4F6B',
  listening: '#16B8A6',
  delegating: '#F2A33C',
  speaking: '#7C5CFF',
}

const PHASE_LABEL: Record<Phase, string> = {
  idle: 'Not connected',
  connecting: 'Connecting',
  listening: 'Listening',
  delegating: 'Thinking in the background',
  speaking: 'Speaking',
}

interface Line {
  id: string
  role: 'user' | 'assistant' | 'delegate'
  text: string
}

/** Runs one delegated prompt through the server route and returns the spoken answer. */
async function askDelegate(prompt: string): Promise<string> {
  const response = await fetch('/api/delegate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })
  if (response.body === null) throw new Error('delegate returned no body')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let answer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const chunks = buffer.split('\n')
    buffer = chunks.pop() ?? ''
    for (const chunk of chunks) {
      if (chunk.trim() === '') continue
      const line = JSON.parse(chunk) as { type: string; text: string }
      if (line.type === 'done') answer = line.text
      if (line.type === 'error') throw new Error(line.text)
    }
  }
  return answer
}

export default function LiveCall({ voice = 'cove' }: { voice?: LiveVoice }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [lines, setLines] = useState<Line[]>([])
  const [error, setError] = useState<string | null>(null)

  const pcRef = useRef<RTCPeerConnection | null>(null)
  const sessionRef = useRef<LiveSession | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  /** Assistant turns still open, so `speaking` ends only when the last one closes. */
  const openTurns = useRef(new Set<string>())

  const record = useCallback((line: Line) => {
    setLines((prev) => [...prev.filter((entry) => entry.id !== line.id), line].slice(-40))
  }, [])

  const onTurn = useCallback(
    (turn: LiveTurn, stage: 'created' | 'delta' | 'done') => {
      record({ id: turn.id, role: turn.role, text: turn.transcript.trim() })
      if (turn.role !== 'assistant') return
      if (stage === 'created') {
        openTurns.current.add(turn.id)
        setPhase('speaking')
      }
      if (stage === 'done') {
        openTurns.current.delete(turn.id)
        if (openTurns.current.size > 0) return
        setPhase((sessionRef.current?.pending.size ?? 0) > 0 ? 'delegating' : 'listening')
      }
    },
    [record],
  )

  const hangUp = useCallback(() => {
    sessionRef.current?.close()
    pcRef.current?.close()
    streamRef.current?.getTracks().forEach((track) => track.stop())
    sessionRef.current = null
    pcRef.current = null
    streamRef.current = null
    openTurns.current.clear()
    setPhase('idle')
  }, [])

  const connect = useCallback(async () => {
    setError(null)
    setLines([])
    setPhase('connecting')
    try {
      const pc = new RTCPeerConnection()
      pcRef.current = pc

      // Remote audio arrives as a track, so it needs a sink to actually play.
      pc.ontrack = (event) => {
        if (audioRef.current === null) return
        audioRef.current.srcObject = event.streams[0] ?? null
        void audioRef.current.play()
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream))

      // The channel must exist before createOffer, or it is missing from the SDP.
      const channel = pc.createDataChannel('oai-events')

      sessionRef.current = attachLiveSession(channel, {
        onSessionStarted: () => setPhase('listening'),
        onTurn,
        onError: (cause) => setError(cause.message),
        onDelegate: async (prompt, item) => {
          setPhase((current) => (current === 'speaking' ? current : 'delegating'))
          record({ id: `delegate-${item.id}`, role: 'delegate', text: `${prompt} …` })
          try {
            const answer = await askDelegate(prompt)
            record({ id: `delegate-${item.id}`, role: 'delegate', text: answer })
            return answer
          } finally {
            setPhase((current) => (current === 'delegating' ? 'listening' : current))
          }
        },
      })

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      if (offer.sdp === undefined) throw new Error('offer had no SDP')

      const response = await fetch('/api/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sdp: offer.sdp, voice }),
      })
      const payload = (await response.json()) as { sdp?: string; error?: string }
      if (!response.ok || payload.sdp === undefined) throw new Error(payload.error ?? 'call failed')

      await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp })
    } catch (cause) {
      setError((cause as Error).message)
      hangUp()
    }
  }, [hangUp, onTurn, record, voice])

  useEffect(() => () => hangUp(), [hangUp])

  const live = phase !== 'idle'

  return (
    <div className="call">
      <FluidOrb size={260} color={PHASE_COLOR[phase]} />

      <p className="phase">{PHASE_LABEL[phase]}</p>

      <button className="action" onClick={live ? hangUp : () => void connect()}>
        {live ? 'End call' : 'Start call'}
      </button>

      {error !== null && <p className="error">{error}</p>}

      <div className="transcript">
        {lines.map((line) => (
          <p key={line.id} className={`line line-${line.role}`}>
            <span className="who">{line.role}</span>
            {line.text}
          </p>
        ))}
      </div>

      <audio ref={audioRef} autoPlay hidden />
    </div>
  )
}
