import { on } from '@movogo-io/service/event'

on('status', 'greeting', { filter: { kind: ['a'] } }, () => {})
