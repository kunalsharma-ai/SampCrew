'use client';

import { WELCOME_SCENE_COOKIE, type WelcomeScene } from '@crew/contracts';
import { useEffect } from 'react';

/**
 * Remembers which level this browser last signed in to, so the next sign-in page opens with that level's welcome.
 * Runs as an effect because the sign-in form moves into the app with client navigation, where inline scripts never run.
 */
export function RememberWelcome({ scene }: { scene: WelcomeScene }) {
  useEffect(() => {
    document.cookie = `${WELCOME_SCENE_COOKIE}=${scene}; path=/; max-age=31536000; samesite=lax`;
  }, [scene]);
  return null;
}
