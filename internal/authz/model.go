package authz

// Model is the relationship schema every capability check runs against
const Model = `model
  schema 1.1

type user

type system
  relations
    define admin: [user]
    define member: [user]
    define users_admin: admin
    define capabilities_read: member or admin
    define timeline_read: member or admin
    define session_self: member or admin
    define credentials_self: member or admin

type space
  relations
    define system: [system]
    define admin: [user] or admin from system
    define member: [user] or admin
    define reader: member
    define writer: member

type channel
  relations
    define space: [space]
    define admin: admin from space
    define reader: reader from space
    define writer: writer from space
`

// SystemObject is the single system-level authorization object
const SystemObject = "system:main"
