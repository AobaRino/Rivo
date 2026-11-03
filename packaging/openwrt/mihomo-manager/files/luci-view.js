'use strict';
'require view';
'require rpc';
'require ui';
'require poll';

var status = rpc.declare({object: 'mihomo-manager', method: 'status', expect: {'': {}}});
var configure = rpc.declare({object: 'mihomo-manager', method: 'configure', params: ['port'], expect: {'': {}}});
var power = rpc.declare({object: 'mihomo-manager', method: 'set_enabled', params: ['enabled'], expect: {'': {}}});
var autostart = rpc.declare({object: 'mihomo-manager', method: 'set_autostart', params: ['enabled'], expect: {'': {}}});
var bootstrap = rpc.declare({object: 'mihomo-manager', method: 'bootstrap', expect: {'': {}}});

return view.extend({
    load: function() { return status(); },
    render: function(initial) {
        var current = initial, pending = false;
        var summary = E('p');
        var address = E('a', {target: '_blank', rel: 'noopener noreferrer', 'class': 'cbi-button cbi-button-action'}, '打开管理面板');
        var port = E('input', {type:'number', min:1024, max:65535, value:initial.port, style:'width:140px'});
        var button = E('button', {'class': 'cbi-button cbi-button-action'});
        var boot = E('input', {type:'checkbox', 'aria-label':'开机启动'});
        function show(s) {
            current = s;
            summary.textContent = 'Web：' + (s.web ? '运行中' : '已停止') + '　内核：' + (s.core ? '运行中' : '已停止') + '　网络接管：' + (s.network ? '已启用' : '未启用');
            button.textContent = s.enabled || s.web || s.core || s.network ? '关闭全部服务' : '启动全部服务';
            address.href = 'https://' + (s.urlHost || location.hostname) + ':' + s.port + '/';
            address.style.display = s.web ? '' : 'none';
            button.disabled = pending || !L.hasViewPermission();
            boot.checked = !!s.autoStart;
            boot.disabled = pending || !s.enabled || !L.hasViewPermission();
        }
        async function run(work) {
            if (pending) return;
            pending = true; show(current);
            try { var result = await work(); if (result.error) throw new Error(result.error); show(await status()); }
            catch (e) { ui.addNotification(null, E('p', {}, e.message), 'error'); }
            finally { pending = false; show(current); }
        }
        button.onclick = function() {
            var off = current.enabled || current.web || current.core || current.network;
            if (!off) return run(function() { return power(true); });
            ui.showModal('关闭全部服务', [
                E('p', {}, '将撤销 Rivo 的网络接管，停止内核和 Web 服务，并关闭开机启动。配置保留。'),
                E('div', {'class':'right'}, [
                    E('button', {'class':'btn', click:ui.hideModal}, '取消'),
                    ' ', E('button', {'class':'btn cbi-button-negative', click:function() { ui.hideModal(); return run(function() { return power(false); }); }}, '确认关闭')
                ])
            ]);
        };
        boot.onchange = function() {
            var enabled = boot.checked;
            return run(function() { return autostart(enabled); });
        };
        var save = E('button', {'class':'cbi-button cbi-button-save', click:function() {
            var value = Number(port.value);
            if (!Number.isInteger(value) || value < 1024 || value > 65535) { ui.addNotification(null,E('p',{},'端口范围为 1024–65535'),'error'); return; }
            return run(function() { return configure(value); });
        }}, '保存端口');
        var setup = E('button', {'class':'cbi-button', click:function() {
            return run(async function() {
                var result = await bootstrap();
                if (result.error) return result;
                if (result.token) {
                    var link = E('a', {href:address.href + '#setup=' + encodeURIComponent(result.token),target:'_blank',rel:'noopener noreferrer','class':'cbi-button cbi-button-action'}, '设置管理密码');
                    ui.showModal('初始化独立面板',[E('p',{},'此链接仅用于首次设置密码，使用后失效。'),link,E('div',{'class':'right'},E('button',{'class':'btn',click:ui.hideModal},'关闭'))]);
                } else ui.addNotification(null,E('p',{},'已经设置管理密码，请直接打开面板登录。'));
                return {};
            });
        }}, '初始化管理密码');
        save.disabled = !L.hasViewPermission();
        setup.disabled = !L.hasViewPermission();
        poll.add(async function() { if (!pending) show(await status()); }, 5);
        show(initial);
        return E('div', {'class':'cbi-map'}, [
            E('h2', {}, 'Rivo'),
            E('p', {}, '独立 Web 管理面板。总开关同时控制 Web、Mihomo 内核和本项目的网络接管。'),
            summary, E('div',{'style':'display:flex;gap:12px;flex-wrap:wrap;margin:20px 0'},[button,address,setup]),
            E('h3',{},'开机启动'),
            E('label',{'style':'display:flex;align-items:center;gap:8px'},[boot,'路由器开机时启动 Web、内核及已配置的流量接管']),
            E('p',{},'修改此项不影响当前运行。关闭全部服务会同时关闭开机启动；再次启动全部服务后，可按需重新勾选。'),
            E('h3',{},'Web 监听端口'), E('div',{'style':'display:flex;gap:12px'},[port,save]),
            E('p',{},'修改端口仅重启 Web 服务；内核和网络接管继续运行。Web 仅监听 LAN 管理地址。')
        ]);
    },
	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
