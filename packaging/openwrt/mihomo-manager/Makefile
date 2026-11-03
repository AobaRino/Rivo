include $(TOPDIR)/rules.mk

PKG_NAME:=mihomo-manager
PKG_VERSION:=0.1.0
PKG_RELEASE:=20
PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)
PKG_BUILD_PARALLEL:=1

include $(INCLUDE_DIR)/package.mk

define Package/mihomo-manager
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Rivo configuration workspace and LAN runtime
  DEPENDS:=@x86_64 +procd +curl +kmod-nft-tproxy +kmod-nft-socket
  USERID:=mihomomgr:mihomomgr
endef

define Package/luci-app-mihomo-manager
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=LuCI interface for Rivo
  DEPENDS:=+mihomo-manager +luci-base +rpcd +uhttpd
  PKGARCH:=all
endef

define Package/mihomo-manager/conffiles
/etc/mihomo-manager/
/etc/mihomo-manager-runtime/
/etc/config/mihomo-manager
/etc/mihomo-manager.disabled
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Compile
	test "$(ARCH)" = "x86_64"
	test -s $(CURDIR)/prebuilt/mihomo-manager
	test -s $(CURDIR)/prebuilt/web/index.html
endef

define Package/mihomo-manager/install
	$(INSTALL_DIR) $(1)/usr/bin $(1)/etc/init.d $(1)/usr/share/mihomo-manager $(1)/lib/upgrade/keep.d $(1)/usr/libexec $(1)/etc/config
	$(INSTALL_BIN) $(CURDIR)/prebuilt/mihomo-manager $(1)/usr/bin/mihomo-manager
	$(INSTALL_BIN) ./files/mihomo-manager.init $(1)/etc/init.d/mihomo-manager
	$(INSTALL_BIN) ./files/mihomo-manager-system.init $(1)/etc/init.d/mihomo-manager-system
	$(INSTALL_DATA) ./files/web.config $(1)/etc/config/mihomo-manager
	$(INSTALL_DIR) $(1)/usr/share/mihomo-manager/web $(1)/usr/share/mihomo-manager/dashboard
	$(CP) $(CURDIR)/prebuilt/web/. $(1)/usr/share/mihomo-manager/web/
	$(CP) $(CURDIR)/prebuilt/dashboard/. $(1)/usr/share/mihomo-manager/dashboard/
	$(INSTALL_DATA) ./files/initial.yaml $(1)/usr/share/mihomo-manager/initial.yaml
	$(INSTALL_DATA) ./files/mihomo-manager.keep $(1)/lib/upgrade/keep.d/mihomo-manager
	$(INSTALL_BIN) ./files/mihomo-manager-core.init $(1)/etc/init.d/mihomo-manager-core
	$(INSTALL_BIN) ./files/mihomo-manager-apply.init $(1)/etc/init.d/mihomo-manager-apply
	$(INSTALL_BIN) ./files/mihomo-manager-network.init $(1)/etc/init.d/mihomo-manager-network
	$(INSTALL_BIN) ./files/mihomo-manager-network $(1)/usr/libexec/mihomo-manager-network
	$(INSTALL_DATA) ./files/lan.nft $(1)/usr/share/mihomo-manager/lan.nft
endef

define Package/luci-app-mihomo-manager/install
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/mihomo-manager $(1)/usr/libexec/rpcd
	$(INSTALL_DATA) ./files/luci-view.js $(1)/www/luci-static/resources/view/mihomo-manager/index-r17-rivo.js
	$(INSTALL_BIN) ./files/rpc-service $(1)/usr/libexec/rpcd/mihomo-manager
	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./files/menu.json $(1)/usr/share/luci/menu.d/luci-app-mihomo-manager.json
	$(INSTALL_DATA) ./files/acl.json $(1)/usr/share/rpcd/acl.d/luci-app-mihomo-manager.json
endef

define Package/luci-app-mihomo-manager/postinst
#!/bin/sh
if [ -z "$${IPKG_INSTROOT}" ]; then
	rm -f /tmp/luci-indexcache.*
	/etc/init.d/rpcd reload
fi
exit 0
endef

$(eval $(call BuildPackage,mihomo-manager))
$(eval $(call BuildPackage,luci-app-mihomo-manager))
