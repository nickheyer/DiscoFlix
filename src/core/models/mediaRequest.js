const BaseModel = require('./base');

class MediaRequest extends BaseModel {
  constructor(core) {
    super(core, 'MediaRequest');
  }

  // HELPERS - madeInId IS NULL FOR CONSOLE-INITIATED (SEARCH & ADD) REQUESTS
  async createRequest(data = {}) {
    if (!data.mediaId) {
      throw new Error('Missing required field: mediaId');
    }

    // ROWS BORN DECIDED (AUTO-APPROVE, CONSOLE ADD) STAMP THEIR DECISION TIME
    if (data.status !== null && data.status !== undefined && !data.decided_at) {
      data.decided_at = new Date();
    }
    return this.create(data);
  }

  // SLASH FLOWS HAVE NO TRIGGERING USER MESSAGE - THE BOT'S OWN OUTCOME CARD
  // BECOMES THE JUMP ANCHOR ONCE ITS MESSAGE ID IS KNOWN
  async stampAnchor(requestId, messageId) {
    if (!messageId) return null;
    return this.update({ id: requestId }, { orig_message_id: String(messageId) });
  }

  async getWithRelations(requestId) {
    return this.findFirst(
      { id: requestId },
      {
        users: true,
        made_in: true,
        media: true,
        app: true
      }
    );
  }

  async addUser(requestId, userId) {
    return this.update(
      { id: requestId },
      {
        users: {
          connect: { id: userId }
        }
      }
    );
  }

  async removeUser(requestId, userId) {
    return this.update(
      { id: requestId },
      {
        users: {
          disconnect: { id: userId }
        }
      }
    );
  }

  async updateStatus(requestId, status, message = null) {
    const updates = { status };
    if (message) {
      updates.orig_message = message;
    }
    // A NON-NULL STATUS IS THE DECISION MOMENT - THE PIPELINE SHOWS THIS STAMP
    if (status !== null) {
      updates.decided_at = new Date();
    }

    return this.update({ id: requestId }, updates);
  }

  // SEARCH + FILTER
  async getUserRequests(userId, include = {}, { skip, take } = {}) {
    return this.prisma.mediaRequest.findMany({
      where: {
        users: {
          some: { id: userId }
        }
      },
      include: {
        media: true,
        made_in: true,
        ...include
      },
      orderBy: { created_at: 'desc' },
      ...(skip !== undefined && { skip }),
      ...(take !== undefined && { take })
    });
  }

  async countUserRequests(userId) {
    return this.prisma.mediaRequest.count({
      where: {
        users: {
          some: { id: userId }
        }
      }
    });
  }

  async getServerRequests(serverId, include = {}) {
    return this.getMany(
      { madeInId: serverId },
      {
        users: true,
        media: true,
        ...include
      },
      { created_at: 'desc' }
    );
  }

  async getPendingRequests() {
    return this.getMany(
      { status: null },
      {
        users: true,
        media: true,
        made_in: true
      },
      { created_at: 'asc' }
    );
  }

  // CLEANUP
  async deleteWithRelations(requestId) {
    await this.update( // DISCONNECT USERS FIRST
      { id: requestId },
      {
        users: {
          set: []
        }
      }
    );

    return this.delete({ id: requestId });
  }
}

module.exports = MediaRequest;
