import {render} from 'solid-js/web';
import appNavigationController from '@components/appNavigationController';
import appImManager, {APP_TABS} from '@lib/appImManager';
import ExploreGrid from './exploreGrid';

const OPEN_BODY_CLASS = 'svipe-search-open';
const HIDDEN_CLASS = 'svipe-search--hidden';

/**
 * Owns the Search-tab explore grid (Android's SvipeExploreGrid). Unlike the
 * reels controller, the Solid tree is mounted once into #svipe-search and kept
 * alive across tab switches — close() only hides it (visibility, not
 * display:none, so the scroller keeps its scroll position), matching Android
 * keeping the grid fragment alive in its pager.
 */
class SearchController {
  private mounted = false;
  private opened = false;
  private mount?: HTMLElement;
  private scroller?: HTMLElement;
  private onCloseCb?: () => void;

  public get isOpen() {
    return this.opened;
  }

  public open(opts?: {onClose?: () => void}) {
    if(this.opened) return;

    const mount = this.mount ??= document.getElementById('svipe-search') || undefined;
    if(!mount) return;

    this.opened = true;
    this.onCloseCb = opts?.onClose;

    if(!this.mounted) {
      this.mounted = true;
      // Persistent tree: the dispose function is intentionally dropped.
      render(() => (
        <ExploreGrid
          onEngageSearch={() => this.engageNativeSearch()}
          registerScroller={(el) => (this.scroller = el)}
        />
      ), mount);
    } else {
      mount.classList.remove(HIDDEN_CLASS);
    }

    document.body.classList.add(OPEN_BODY_CLASS);
    appNavigationController.pushItem({
      type: 'svipe-search',
      onPop: () => {
        this.close(true);
      }
    });
  }

  public close(fromPop?: boolean) {
    if(!this.opened) return;
    this.opened = false;

    this.mount?.classList.add(HIDDEN_CLASS);
    document.body.classList.remove(OPEN_BODY_CLASS);

    if(!fromPop) {
      appNavigationController.removeByType('svipe-search', true);
    }

    const cb = this.onCloseCb;
    this.onCloseCb = undefined;
    cb?.();
  }

  /**
   * The grid's search pill is a decoy — tapping it hands off to tweb's real
   * chat-list search (Android parity: the Search tab engages the native
   * search UI). Closing first fires onClose so the tab bar can re-highlight.
   */
  public engageNativeSearch() {
    this.close();
    appImManager.selectTab(APP_TABS.CHATLIST);
    setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>('.item-main .input-search input');
      input?.focus();
    }, 100);
  }

  /** Re-tap on the Search tab: jump close, then smooth-scroll to the top. */
  public scrollToTop() {
    const el = this.scroller;
    if(!el) return;
    const jumpTo = el.clientHeight * 3;
    if(el.scrollTop > jumpTo) el.scrollTop = jumpTo;
    el.scrollTo({top: 0, behavior: 'smooth'});
  }
}

const searchController = new SearchController();
export default searchController;
