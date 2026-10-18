/** Base tool interface. All tools implement these methods. */
export class BaseTool {
    constructor(name, icon) {
        this.name = name;
        this.icon = icon;
        // Mobile action buttons: [{label, icon, action: 'primary'|'secondary'|custom}]
        this.mobileActions = [];
    }
    onEquip(main) {}
    onUnequip(main) {}
    onPrimaryFire(main) {}
    onSecondaryFire(main) {}
    /** Wheel while this tool is out; return true to keep the wheel from switching tools. */
    onScroll(main, delta, event) { return false; }
    update(main, delta) {}
}
