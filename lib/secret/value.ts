import { text } from 'node:stream/consumers'
import { Refusal } from './refusal.js'

const valueBytesMax = 4096

/**
The value of a put: typed without echo and ended by Enter when standard input is a terminal,
else all of standard input less one trailing line break. It is never an argument, which a shell
history and a process listing would keep.
*/
export async function readValue(stdin: Terminal | AsyncIterable<Uint8Array> = process.stdin) {
    if ('isTTY' in stdin && stdin.isTTY === true) {
        return await typedValue(stdin)
    }
    return (await text(stdin)).replace(/\r?\n$/u, '')
}

export function checkedValue(value: string, multiline: boolean) {
    if (value === '') {
        throw new Refusal('the value is empty')
    }
    if (!multiline && /[\r\n]/u.test(value)) {
        throw new Refusal('the value holds a line break; use --multiline if it is meant to')
    }
    if (valueBytesMax < Buffer.byteLength(value, 'utf-8')) {
        throw new Refusal('the value is over 4,096 bytes, the most a parameter holds')
    }
    return value
}

type Terminal = AsyncIterable<Uint8Array> & {
    isTTY?: boolean
    setRawMode?: (raw: boolean) => unknown
    resume: () => unknown
    pause: () => unknown
    on: (event: 'data', listener: (data: Buffer) => void) => unknown
    off: (event: 'data', listener: (data: Buffer) => void) => unknown
}

// In raw mode an arrow key or Ctrl-D arrives as control characters, which would silently become
// part of the credential. Nothing typed is said back.
function typedValue(stdin: Terminal) {
    return new Promise<string>((resolve, reject) => {
        const typed: string[] = []
        const ended = (finish: () => void) => {
            stdin.setRawMode?.(false)
            stdin.pause()
            stdin.off('data', onData)
            finish()
        }
        const onData = (data: Buffer) => {
            for (const character of data.toString('utf-8')) {
                if (character === '\r' || character === '\n') {
                    ended(() => {
                        resolve(typed.join(''))
                    })
                    return
                }
                if (character === '\u{7F}' || character === '\b') {
                    typed.pop()
                    continue
                }
                if (character === '\u{3}') {
                    ended(() => {
                        reject(new Refusal('interrupted; nothing was put'))
                    })
                    return
                }
                if (character < ' ') {
                    ended(() => {
                        reject(
                            new Refusal(
                                'a control character was typed, as an arrow key or Ctrl-D sends; nothing was put. Type the value and end it with Enter, or pipe it in',
                            ),
                        )
                    })
                    return
                }
                typed.push(character)
            }
        }
        stdin.setRawMode?.(true)
        stdin.resume()
        stdin.on('data', onData)
    })
}
