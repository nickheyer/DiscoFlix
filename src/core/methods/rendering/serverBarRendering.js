const _ = require('lodash');

module.exports = {
  // ONE BUBBLE'S TEMPLATE LOCALS - SHARED BY THE STRIP RENDER AND THE SCOPED
  // PER-BUBBLE OOB PUSHES
  bubbleLocals(serverRow, activeID, appActive) {
    return {
      id: serverRow.server_id,
      serverSortPosition: serverRow.sort_position,
      serverName: serverRow.server_name,
      serverTrunc: serverRow.server_name.slice(0, 2),
      serverActive: serverRow.server_id === activeID,
      appActive,
      serverUnread: serverRow.unread_message_count,
      serverImage: serverRow.server_avatar_url,
      serverAvailable: serverRow.available
    };
  },

  async createServerBubbles(serverRows = [], state = null, activeServer = null) {
    const serverBubbles = [];
    state = state || await this.core.models.state.get();
    activeServer = activeServer || await this.core.models.state.getActiveServer(state);
    const activeID = activeServer ? activeServer.server_id : null;
    const appActive = !!state.active_app_id;

    for (const serverRow of serverRows) {
      const serverBubbleHTML = await this.compile(
        ['sidebar/servers/serverBubble.pug'],
        this.bubbleLocals(serverRow, activeID, appActive)
      );

      serverBubbles.push(serverBubbleHTML);
    }
    return serverBubbles;
  },

  async createActiveChannels(channels, currentChannelID = null) {
    const sortedChannels = _.sortBy(channels, ['parent_id', 'position']);
    const categories = {};
    const uncategorized = [];

    for (const channel of sortedChannels) {
      if (channel.isCategory) {
        categories[channel.channel_id] = { category: channel, channels: [] };
      }
    }

    for (const channel of sortedChannels) {
      if (!channel.isTextChannel) continue;
      if (channel.parent_id && categories[channel.parent_id]) {
        categories[channel.parent_id].channels.push(channel);
      } else {
        // TEXT CHANNELS OUTSIDE ANY CATEGORY RENDER FIRST, LIKE DISCORD
        uncategorized.push(channel);
      }
    }

    const channelElems = [];

    const renderChannel = async (channel) => {
      channel.isActiveChannel = channel.channel_id === currentChannelID;
      return this.compile(['sidebar/channels/chatChannel.pug'], channel);
    };

    for (const channel of uncategorized) {
      channelElems.push(await renderChannel(channel));
    }

    const validCategories = _.filter(_.values(categories), (ch) => !_.isEmpty(ch.channels));
    for (const { category, channels: categoryChannels } of validCategories) {
      const categoryHTML = await this.compile([
        'sidebar/channels/chatChannelsHeader.pug'
      ], category);
      channelElems.push(categoryHTML);

      for (const channel of categoryChannels) {
        channelElems.push(await renderChannel(channel));
      }
    }
    return channelElems;
  },

  async getOneServerTemplate(serverID) {
    const targetId = serverID ||
      (await this.core.models.state.getActiveServer())?.server_id;
    const activeServer = targetId
      ? await this.core.models.discordServer.getComplete(targetId)
      : null;

    if (activeServer?.channels) {
      const validChannelIds = activeServer.channels
        .filter(ch => ch.isTextChannel)
        .map(ch => ch.channel_id);

      const currentChannelView = await this.ensureActiveChannel(activeServer, validChannelIds);
      activeServer.active_channel_id = currentChannelView;

      const activeChannel = _.find(activeServer.channels, ['channel_id', currentChannelView]);
      const channels = await this.createActiveChannels(activeServer.channels, currentChannelView);

      return {
        activeServer,
        channels,
        activeChannel
      };
    }

    return {
      activeServer: {},
      channels: [],
      activeChannel: {}
    };
  },

  async getServerTemplateObj(serverRows = [], state = null) {
    if (_.isEmpty(serverRows)) {
      serverRows = await this.core.models.discordServer.getSorted();
    }

    if (!_.isEmpty(serverRows)) {
      await this.ensureActiveServer(serverRows[0].server_id);
    }

    let channels = [];
    let activeServer = await this.core.models.state.getActiveServer();
    let activeChannel = null;

    if (activeServer) {
      // ONE getComplete PER RENDER PASS; ensureActiveChannel WORKS ON THE
      // ALREADY-LOADED RECORD
      activeServer = await this.core.models.discordServer.getComplete(activeServer.server_id);

      if (activeServer?.channels) {
        const validChannelIds = activeServer.channels
          .filter(ch => ch.isTextChannel)
          .map(ch => ch.channel_id);

        const currentChannelView = await this.ensureActiveChannel(activeServer, validChannelIds);
        activeServer.active_channel_id = currentChannelView;

        activeChannel = _.find(activeServer.channels, ['channel_id', currentChannelView]);
        channels = await this.createActiveChannels(activeServer.channels, currentChannelView);
      }
    }

    const serverBubbles = await this.createServerBubbles(
      serverRows,
      state,
      activeServer
    );

    return {
      serverBubbles,
      serverRows,
      activeServer,
      channels,
      activeChannel
    };
  },

  // MEMBERS PANE VIEW MODEL, PHASE 2 - TRACKED USERS (THE JOIN TABLE FILLS AS
  // MESSAGES SYNC) ENRICHED WITH LIVE GUILD DATA WHILE THE BOT IS ONLINE:
  // HOISTED-ROLE GROUPS LIKE OLD DISCORD, PRESENCE DOTS WHEN THE PRIVILEGED
  // INTENT IS ON (DF_PRESENCE_INTENT=1 + THE DEV-PORTAL TOGGLE), OFFLINE
  // MEMBERS SINK TO A FADED OFFLINE GROUP. RETURNS { groups, total }.
  async getServerMembers(serverId) {
    if (!serverId) {
      const activeServer = await this.core.models.state.getActiveServer();
      serverId = activeServer?.server_id;
    }
    if (!serverId) return { groups: [], total: 0 };

    const rows = await this.core.models.user.getMany(
      { discord_servers: { some: { server_id: serverId } } },
      {},
      [{ is_client: 'desc' }, { username: 'asc' }]
    );
    if (!rows.length) return { groups: [], total: 0 };

    const client = this.core.client;
    const botOnline = !!(client && client.isReady());
    const guild = botOnline ? client.guilds.cache.get(serverId) : null;
    const { GatewayIntentBits } = require('discord.js');
    const presenceOn = !!guild && client.options.intents.has(GatewayIntentBits.GuildPresences);

    const roleGroups = new Map();
    const ungrouped = [];
    const offline = [];
    for (const row of rows) {
      const member = guild?.members.cache.get(row.id);
      const status = row.is_client
        ? (botOnline ? 'online' : 'offline')
        : (presenceOn ? (member?.presence?.status || 'offline') : null);
      const vm = { ...row, status };

      // THE CLIENT BOT ALWAYS SHOWS AT THE TOP OF THE FIRST GROUP
      if (!row.is_client && presenceOn && status === 'offline') {
        offline.push(vm);
        continue;
      }
      const hoisted = member?.roles?.hoist || null;
      if (hoisted && !row.is_client) {
        if (!roleGroups.has(hoisted.id)) {
          roleGroups.set(hoisted.id, { label: hoisted.name, position: hoisted.position, members: [] });
        }
        roleGroups.get(hoisted.id).members.push(vm);
      } else {
        ungrouped.push(vm);
      }
    }

    const groups = [...roleGroups.values()].sort((a, b) => b.position - a.position);
    if (ungrouped.length) groups.push({ label: presenceOn ? 'Online' : 'Members', members: ungrouped });
    if (offline.length) groups.push({ label: 'Offline', offline: true, members: offline });
    return { groups, total: rows.length };
  },

  // FIRST-RUN CHECKLIST VIEW MODEL - null UNLESS A TOKEN OR SERVER IS STILL MISSING
  async getOnboarding(state) {
    if (state?.active_app_id) return null;
    const config = await this.core.models.configuration.get();
    const serverCount = await this.core.prisma.discordServer.count();
    if (config.discord_token && serverCount > 0) return null;

    const [appCount, requestCount] = await Promise.all([
      this.core.prisma.app.count(),
      this.core.prisma.mediaRequest.count()
    ]);
    const botOnline = !!(this.core.client && this.core.client.isReady());
    return {
      steps: [
        {
          label: 'Add your Discord bot token',
          done: !!config.discord_token,
          // post CTAs ENTER A TAKEOVER INSTEAD OF OPENING A MODAL
          cta: { label: 'Open DiscoFlix Settings', post: '/discoflix/section/settings' }
        },
        {
          label: 'Power the bot on',
          done: botOnline,
          cta: { label: 'Open Power Menu', url: '/modal/bot/power' }
        },
        {
          label: 'Invite the bot to your Discord server',
          done: serverCount > 0,
          cta: { label: 'Get Invite Link', url: '/modal/bot/invite' }
        },
        {
          label: 'Connect an app like Radarr or Sonarr',
          done: appCount > 0,
          cta: { label: 'Add an App', url: '/modal/apps/picker' }
        },
        {
          label: 'Make your first request',
          done: requestCount > 0,
          hint: `Type ${config.prefix_keyword} movie <title> in Discord, or search an app's Library from its right-rail search bar`
        }
      ]
    };
  },

  // ACCEPTS A LOADED SERVER RECORD (WITH OR WITHOUT CHANNELS) OR AN ID, AND
  // RETURNS THE VALID ACTIVE CHANNEL ID - CALLERS DON'T NEED TO REFETCH.
  async ensureActiveChannel(serverOrId, validChannelIds) {
    const server = typeof serverOrId === 'string'
      ? await this.core.models.discordServer.getById(serverOrId)
      : serverOrId;
    if (!server) return null;

    const current = server.active_channel_id;
    if (current && validChannelIds.includes(current)) return current;

    const channels = server.channels ||
      await this.core.models.discordChannel.getMany({ discord_server: server.server_id });
    const firstTextChannel =
      _.find(channels, (ch) => ch.isTextChannel && ch.parent_id && ch.position === 0) ||
      _.find(channels, (ch) => ch.isTextChannel);
    if (!firstTextChannel) return null;

    await this.core.models.discordServer.update(
      { server_id: server.server_id },
      { active_channel_id: firstTextChannel.channel_id }
    );
    return firstTextChannel.channel_id;
  },

  async ensureActiveServer(defaultServerId) {
    const activeServer = await this.core.models.state.getActiveServer();
    if (!activeServer) {
      this.logger.info(`No active server detected, setting active to: ${defaultServerId}`);
      await this.core.models.state.changeActive(defaultServerId);
    }
  },
};
