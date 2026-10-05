import { useEffect, useState } from 'react'

const XL_BREAKPOINT = 1280

/**
 * Tracks the Tailwind `xl` breakpoint (>=1280px). Used where a component must
 * swap implementations by size (e.g. inline detail panel vs. Sheet).
 */
export function useIsXl() {
  const [isXl, setIsXl] = useState(false)

  useEffect(() => {
    const mql = window.matchMedia(`(min-width: ${XL_BREAKPOINT}px)`)
    const onChange = () => setIsXl(window.innerWidth >= XL_BREAKPOINT)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return isXl
}
