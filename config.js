export default {
  master: {
    host: 'mysql-master',
    user: 'root',
    password: 'root',
    database: 'blogdb',
    port: 3306, // internal container port (don’t use 3307 here)
  },
  slaves: [
    {
      host: 'mysql-slave1',
      user: 'root',
      password: 'root',
      database: 'blogdb',
      port: 3306,
    },
    {
      host: 'mysql-slave2',
      user: 'root',
      password: 'root',
      database: 'blogdb',
      port: 3306,
    },
  ],
};
