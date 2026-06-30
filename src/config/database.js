const mongoose = require("mongoose");

const connectDB = async () => {
  await mongoose.connect(
    "mongodb+srv://abhisheksatyam96_db_user:7Q4bUZPujTJotXKS@satyamcluster.ajbozys.mongodb.net/devTinder?appName=SatyamCluster",
  );
};

module.exports = connectDB;