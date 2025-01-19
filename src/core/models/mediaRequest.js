const BaseModel = require('./base');

class MediaRequest extends BaseModel {
  constructor(core) {
    super(core, 'MediaRequest');
  }

  // HELPERS
  async createRequest(data = {}) {
    const required = ['madeInId', 'mediaId'];
    for (const field of required) {
      if (!data[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    return this.create(data);
  }

  async getWithRelations(requestId) {
    return this.findFirst(
      { id: requestId },
      {
        users: true,
        made_in: true,
        media: true
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
    
    return this.update({ id: requestId }, updates);
  }

  // SEARCH + FILTER
  async getUserRequests(userId, include = {}) {
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
      orderBy: { created_at: 'desc' }
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
