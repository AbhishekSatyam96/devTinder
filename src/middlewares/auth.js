const jwt = require("jsonwebtoken");
const User = require("../models/user");

const userAuth = async (req, res, next) => {
  try {
    const token = req.cookies.token;
    const decodeObj = await jwt.verify(token, "secretKey");
    console.log("Decoded Object:", decodeObj);
    const { userId } = decodeObj;
    const user = await User.findById(userId);
    if (!user) {
      throw new Error("User not found");
    }
    req.user = user;
    next();
  } catch (err) {
    res.status(401).send("Invalid token");
  }
};

module.exports = { userAuth };
