import { get } from '@movogo-io/service/http'
import { createHash } from 'node:crypto'

// Answers hashes only: the proofs compare them and no value leaves the function.
get('hash', () => ({
    body: {
        PROOF_VALUE: sha256(process.env.PROOF_VALUE),
        PROOF_LITERAL: sha256(process.env.PROOF_LITERAL),
    },
}))

function sha256(value: string | undefined) {
    if (value === undefined) {
        return null
    }
    return createHash('sha256').update(value).digest('hex')
}
