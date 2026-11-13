/**
What a secret command found wrong itself, on this machine or in what AWS answered as asked for:
one line and exit code 1. An error AWS or anything else raised is not one, and exits 3, so that
a script can tell "check found something" from "check could not run".
*/
// eslint-disable-next-line unicorn/custom-error-definition -- the name the exit codes are told by
export class Refusal extends Error {
    name = 'Refusal'
}

/**
The credential, account and glue checks throw plain errors for what they decide on this machine.
A failed STS call is a plain error too but carries the response, and a failed connection is a
TypeError: both stay what they are. The line is drawn by where an error comes from, never by its
text.
*/
export async function refusing<T>(call: () => Promise<T>) {
    try {
        return await call()
    } catch (e) {
        if (Error.isError(e) && e.name === 'Error' && !('response' in e)) {
            throw new Refusal(e.message, { cause: e })
        }
        throw e
    }
}
