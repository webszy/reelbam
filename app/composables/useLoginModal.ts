export function useLoginModal() {
  const isOpen = useState('login-modal-open', () => false)
  const returnTo = useState('login-modal-return-to', () => '/')
  return { isOpen, returnTo, open: (destination = '/') => { returnTo.value = destination; isOpen.value = true }, close: () => { isOpen.value = false } }
}
