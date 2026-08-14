import { useEffect } from 'react'

import { useUIStore } from '@/stores'

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  const isMobile = useUIStore((state) => state.isMobile)
  const setIsMobile = useUIStore((state) => state.setIsMobile)

  useEffect(() => {
    const checkMobile = () => {
      const newValue = window.innerWidth < MOBILE_BREAKPOINT
      setIsMobile(newValue)
    }

    // Initial check
    checkMobile()

    // Listen for window resize
    window.addEventListener('resize', checkMobile)
    
    return () => window.removeEventListener('resize', checkMobile)
  }, [setIsMobile])

  return isMobile
}