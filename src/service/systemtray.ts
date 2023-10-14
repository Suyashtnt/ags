import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk?version=3.0';
import Gtk from 'gi://Gtk?version=3.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import DbusmenuGtk3 from 'gi://DbusmenuGtk3';
import type DbusmenuGtk3Types from 'types/gtk-types/dbusmenugtk3-0.4.js';
import Service from '../service.js';
import { StatusNotifierItemProxy } from '../dbus/types.js';
import { bulkConnect, loadInterfaceXML } from '../utils.js';
import Widget, { WidgetParams } from '../widget.js';
import type { CommonParams } from 'src/widgets/constructor.js';

const StatusNotifierWatcherIFace = loadInterfaceXML('org.kde.StatusNotifierWatcher')!;
const StatusNotifierItemIFace = loadInterfaceXML('org.kde.StatusNotifierItem')!;
const StatusNotifierItemProxy =
    Gio.DBusProxy.makeProxyWrapper(StatusNotifierItemIFace) as unknown as StatusNotifierItemProxy;

export class TrayItem extends Service {
    static {
        Service.register(this, {
            'removed': ['string'],
            'ready': [],
        }, {
            'menu': ['jsobject'],
            'category': ['string'],
            'id': ['string'],
            'title': ['string'],
            'status': ['string'],
            'window-id': ['int'],
            'is-menu': ['boolean'],
            'tooltip-markup': ['string'],
            'icon': ['jsobject'],
        });
    }

    private _proxy: StatusNotifierItemProxy;
    private _busName: string;

    private _iconTheme?: InstanceType<typeof Gtk.IconTheme>;
    menu?: InstanceType<typeof DbusmenuGtk3.Menu>;

    constructor(busName: string, objectPath: string) {
        super();

        this._busName = busName;

        this._proxy = new StatusNotifierItemProxy(
            Gio.DBus.session,
            busName,
            objectPath,
            this._itemProxyAcquired.bind(this),
            null,
            Gio.DBusProxyFlags.NONE);
    }

    activate(event: InstanceType<typeof Gdk.Event>) {
        this._proxy.ActivateAsync(event.get_root_coords()[1], event.get_root_coords()[2]);
    }

    secondaryActivate(event: InstanceType<typeof Gdk.Event>) {
        this._proxy.SecondaryActivateAsync(event.get_root_coords()[1], event.get_root_coords()[2]);
    }

    scroll(event: InstanceType<typeof Gdk.EventScroll>) {
        const direction = (event.direction == 0 || event.direction == 1)
            ? 'vertical' : 'horizontal';

        const delta = (event.direction == 0 || event.direction == 1)
            ? event.delta_y : event.delta_x;

        this._proxy.ScrollAsync(delta, direction);
    }

    openMenu(event: InstanceType<typeof Gdk.Event>) {
        this.menu
            ? this.menu.popup_at_pointer(event)
            : this._proxy.ContextMenuAsync(event.get_root_coords()[1], event.get_root_coords()[2]);
    }

    get category() { return this._proxy.Category; }
    get id() { return this._proxy.Id; }
    get title() { return this._proxy.Title; }
    get status() { return this._proxy.Status; }
    get window_id() { return this._proxy.WindowId; }
    get is_menu() { return this._proxy.ItemIsMenu; }

    get tooltip_markup() {
        if (!this._proxy.ToolTip)
            return '';

        let tooltipMarkup = this._proxy.ToolTip[2];
        if (this._proxy.ToolTip[3] !== '')
            tooltipMarkup += '\n' + this._proxy.ToolTip[3];

        return tooltipMarkup;
    }

    get icon() {
        const iconName = this.status === 'NeedsAttention'
            ? this._proxy.AttentionIconName
            : this._proxy.IconName;

        if (this._iconTheme && iconName) {
            const size = Math.max(...this._iconTheme.get_icon_sizes(iconName));
            const iconInfo = this._iconTheme.lookup_icon(
                iconName, size, Gtk.IconLookupFlags.FORCE_SIZE);

            if (iconInfo)
                return iconInfo.load_icon();
        }
        const iconPixmap = this.status === 'NeedsAttention'
            ? this._proxy.AttentionIconPixmap
            : this._proxy.IconPixmap;

        return iconName || this._getPixbuf(iconPixmap) || 'image-missing';
    }

    private _itemProxyAcquired(proxy: StatusNotifierItemProxy) {
        if (proxy.Menu) {
            const menu = Widget<
                InstanceType<typeof Gtk.Widget>,
                // quick hack around the weirdness of direct types
                WidgetParams<InstanceType<typeof Gtk.Widget>> & DbusmenuGtk3Types.Menu.ConstructorProperties,
                typeof DbusmenuGtk3.Menu
            >({
                type: DbusmenuGtk3.Menu,
                dbus_name: proxy.g_name_owner,
                dbus_object: proxy.Menu,
            });
            this.menu = menu;
        }

        if (this._proxy.IconThemePath) {
            this._iconTheme = Gtk.IconTheme.new();
            this._iconTheme?.set_search_path([this._proxy.IconThemePath]);
        }

        bulkConnect(proxy, [
            ['notify::g-name-owner', () => {
                if (!proxy.g_name_owner)
                    this.emit('removed', this._busName);
            }],
            ['g-signal', this._refreshAllProperties.bind(this)],
            ['g-properties-changed', () => this.emit('changed')],
        ]);

        ['Title', 'Icon', 'AttentionIcon', 'OverlayIcon', 'ToolTip', 'Status']
            .forEach(prop => proxy.connectSignal(`New${prop}`, () => {
                this._notify();
            }));

        this.emit('ready');
    }

    _notify() {
        [
            'menu', 'category', 'id', 'title', 'status',
            'window-id', 'is-menu', 'tooltip-markup', 'icon',
        ].forEach(prop => this.notify(prop));
        this.emit('changed');
    }

    private _refreshAllProperties() {
        this._proxy.g_connection.call(
            this._proxy.g_name,
            this._proxy.g_object_path,
            'org.freedesktop.DBus.Properties',
            'GetAll',
            new GLib.Variant('(s)', [this._proxy.g_interface_name]),
            GLib.VariantType.new('(a{sv})'),
            Gio.DBusCallFlags.NONE, -1,
            null,
            (proxy, result) => {
                const variant = proxy?.call_finish(result);
                if (!variant)
                    return;
                const [properties] = variant.deepUnpack<Record<string, InstanceType<typeof GLib.Variant>>[]>();
                Object.entries(properties).map(([propertyName, value]) => {
                    this._proxy.set_cached_property(propertyName, value);
                });
                this._notify();
            },
        );
    }

    private _getPixbuf(pixMapArray: [number, number, Uint8Array][]) {
        if (!pixMapArray)
            return;

        const pixMap = pixMapArray.sort((a, b) => a[0] - b[0]).pop();
        if (!pixMap)
            return;


        const array = Uint8Array.from(pixMap[2]);
        for (let i = 0; i < 4 * pixMap[0] * pixMap[1]; i += 4) {
            const alpha = array[i];
            array[i] = array[i + 1];
            array[i + 1] = array[i + 2];
            array[i + 2] = array[i + 3];
            array[i + 3] = alpha;
        }
        return GdkPixbuf.Pixbuf.new_from_bytes(
            new GLib.Bytes(array),
            GdkPixbuf.Colorspace.RGB,
            true,
            8,
            pixMap[0],
            pixMap[1],
            pixMap[0] * 4,
        );
    }
}

class SystemTray extends Service {
    static {
        Service.register(this, {
            'added': ['string'],
            'removed': ['string'],
        }, {
            'items': ['jsobject'],
        });
    }

    private _dbus!: InstanceType<typeof Gio.DBusExportedObject>;
    private _items: Map<string, TrayItem>;

    get IsStatusNotifierHostRegistered() { return true; }
    get ProtocolVersion() { return 0; }
    get RegisteredStatusNotifierItems() { return Array.from(this._items.keys()); }

    get items() { return Array.from(this._items.values()); }
    getItem(name: string) { return this._items.get(name); }

    constructor() {
        super();
        this._items = new Map();
        this._register();
    }

    private _register() {
        Gio.bus_own_name(
            Gio.BusType.SESSION,
            'org.kde.StatusNotifierWatcher',
            Gio.BusNameOwnerFlags.NONE,
            (connection: InstanceType<typeof Gio.DBusConnection>) => {
                this._dbus = Gio.DBusExportedObject
                    .wrapJSObject(StatusNotifierWatcherIFace as string, this);

                this._dbus.export(connection, '/StatusNotifierWatcher');
            },
            null,
            () => {
                print('Another system tray is already running');
            },
        );
    }

    RegisterStatusNotifierItemAsync(serviceName: string[], invocation: InstanceType<typeof Gio.DBusMethodInvocation>) {
        let busName: string, objectPath: string;
        const [service] = serviceName;
        if (service.startsWith('/')) {
            objectPath = service;
            busName = invocation.get_sender()!;
        } else {
            busName = service;
            objectPath = '/StatusNotifierItem';
        }

        invocation.return_value(null);

        const item = new TrayItem(busName, objectPath);
        item.connect('ready', () => {
            this._items.set(busName, item);
            this.emit('added', busName);
            this.notify('items');
            this.emit('changed');
            this._dbus.emit_signal(
                'StatusNotifierItemRegistered',
                new GLib.Variant('(s)', [busName + objectPath]),
            );
        });
        item.connect('removed', () => {
            this._items.delete(busName);
            this.emit('removed', busName);
            this.notify('items');
            this.emit('changed');
            this._dbus.emit_signal(
                'StatusNotifierItemUnregistered',
                new GLib.Variant('(s)', [busName]),
            );
        });
    }
}


export default new SystemTray();
