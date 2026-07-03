import {render} from 'solid-js/web';
import {getOverlayRoot} from '@helpers/appWindow';
import appNavigationController from '@components/appNavigationController';
import type {FeedSeed, ReelItem} from './reelsFeed';
import ReelsView from './reelsView';

const OPEN_BODY_CLASS = 'svipe-reels-open';

export type ReelsOpenOptions = {
  /** svipe.uz/{code} share deep-link — resolved and shown first. */
  seedCode?: string;
  /** An already-resolved reel (explore-grid tap) — shown instantly at index 0. */
  seedReel?: ReelItem;
  /** Conditions the backend continuation feed on this video. */
  seed?: FeedSeed;
  /** Opened from the Search grid: shows a back arrow (Android's seeded mode). */
  fromSearch?: boolean;
  onClose?: () => void;
};

/**
 * Owns the single full-screen reels surface: mounts it into #reels-viewer on
 * demand, registers a 'reels' navigation item so the Android/browser back
 * gesture closes it, and tears everything down on exit. Mirrors the
 * passcode-lock / stories-viewer mount pattern.
 *
 * The reels components read managers via the directly-imported `rootScope`
 * (like the stories viewer and reelsFeed), so no hot-reload-guard context
 * provider is needed here.
 */
class ReelsController {
  private dispose?: () => void;
  private onCloseCb?: () => void;

  public get isOpen() {
    return !!this.dispose;
  }

  public open(opts?: ReelsOpenOptions) {
    if(this.dispose) return;
    this.onCloseCb = opts?.onClose;

    const mount = document.getElementById('reels-viewer') || getOverlayRoot();
    document.body.classList.add(OPEN_BODY_CLASS);

    this.dispose = render(() => (
      <ReelsView
        seedCode={opts?.seedCode}
        seedReel={opts?.seedReel}
        seed={opts?.seed}
        fromSearch={opts?.fromSearch}
        onExit={() => this.close()}
      />
    ), mount);

    appNavigationController.pushItem({
      type: 'reels',
      onPop: () => {
        this.close(true);
      }
    });
  }

  public close(fromPop?: boolean) {
    if(!this.dispose) return;

    this.dispose();
    this.dispose = undefined;
    document.body.classList.remove(OPEN_BODY_CLASS);

    if(!fromPop) {
      appNavigationController.removeByType('reels', true);
    }

    const cb = this.onCloseCb;
    this.onCloseCb = undefined;
    cb?.();
  }
}

const reelsController = new ReelsController();
export default reelsController;
