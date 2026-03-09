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
    onScroll(main, delta) {}
    update(main, delta) {}
}
