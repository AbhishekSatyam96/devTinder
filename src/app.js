const express = require("express");
const connectDB = require("./config/database");
const app = express();
const User = require("./models/user");
const bcrypt = require("bcrypt");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const { userAuth } = require("./middlewares/auth");

app.use(express.json());
app.use(cookieParser());

app.post("/signup", async (req, res) => {
  try {
    const { emailId, password, firstName, lastName } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({
      emailId: emailId,
      password: hashedPassword,
      firstName: firstName,
      lastName: lastName,
    });
    await user.save();
    res.send("User Added Successfully");
  } catch (err) {
    res.status(400).send("Error in adding user " + err.message);
  }
});

app.post("/login", async (req, res) => {
  try {
    const { emailId, password } = req.body;
    const user = await User.findOne({ emailId });
    if (!user) {
      return res.status(400).send("User not found");
    }
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(400).send("Invalid password");
    }
    const token = jwt.sign({ userId: user._id }, "secretKey");
    res.cookie("token", token);
    res.send("Login successful");
  } catch (err) {
    res.status(400).send("Error in adding user " + err.message);
  }
});

app.get("/profile", userAuth, async (req, res) => {
  try {
    res.send(req.user);
  } catch (err) {
    res.status(400).send("Invalid token");
  }
});

app.get("/feed", async (req, res) => {
  try {
    const users = await User.find({});
    res.send(users);
  } catch (err) {
    res.status(400).send("Something went wrong");
  }
});

app.delete("/delete", async (req, res) => {
  const userId = req.body.userId;
  try {
    await User.findByIdAndDelete(userId);
    res.send("User delete successfully..");
  } catch (err) {
    res.status(400).send("Something went wrong");
  }
});

connectDB()
  .then(() => {
    app.listen(4000, () => {
      console.log("Server started");
    });
  })
  .catch((err) => console.log("Database cannot be connected", err));
